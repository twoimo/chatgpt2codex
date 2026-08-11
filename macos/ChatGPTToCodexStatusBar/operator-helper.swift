import CryptoKit
import Darwin
import Foundation
import Security

// The native operator helper is the only process allowed to access the
// operator key. The command-line client never signs; it only submits a
// bounded request to this helper and consumes the response.

enum OperatorHelperContract {
    static let protocolVersion = "github-pr-write-helper-v1"
    static let socketName = "github-pr-write-helper.sock"
    static let socketIdentity = "app.ezbuilder.chatgpt2codex.operator-helper.v1"
    static let attestationHook = "secure-enclave-p256-public-key-v1"
    static let maxFrameBytes = 16 * 1024
    static let maxSocketPathBytes = 104
    static let maxNonceBytes = 128
    static let keyTag = Data("app.ezbuilder.chatgpt2codex.operator.p256".utf8)
    static let operatorProfileId = "p256-secure-enclave-private-key-usage-user-presence-x962-sha256-v1"

    // The administrator envelope is protocolVersion 1. Its signed fields are
    // deliberately fixed; no CLI path, database path, or arbitrary message is
    // accepted by this helper.
    static let adminProtocolVersion = 1
    static let operatorKeyId = "app.ezbuilder.chatgpt2codex.operator.p256"
    static let adminOperations = Set(["enable", "revoke", "status", "quarantine-v4"])
    static let adminLiteralArgv: [String: [String]] = [
        "enable": ["github-pr-write", "--enable"],
        "revoke": ["github-pr-write", "--revoke"],
        "status": ["github-pr-write", "--status"],
        "quarantine-v4": ["github-pr-write", "quarantine-v4"],
    ]
    static let adminRequestKeys = Set([
        "protocolVersion", "operation", "literalArgv", "manifestDigest",
        "generationBefore", "challengeId", "challengeNonce",
        "operatorKeyProfile", "operatorKeyId", "operatorPublicKeyDigest",
        "operatorHelperDigest",
    ])

    // This is the canonical profile consumed by the host-side verifier.
    static let canonicalProfileJSON = "{\"accessControl\":[\"privateKeyUsage\",\"userPresence\"],\"accessibility\":\"WhenUnlockedThisDeviceOnly\",\"algorithm\":\"ECDSA-SHA256-X9.62-DER\",\"curve\":\"P-256\",\"keySize\":256,\"secureEnclave\":true,\"signatureEncoding\":\"DER\"}"
    static let profile: [String: Any] = [
        "curve": "P-256",
        "keySize": 256,
        "secureEnclave": true,
        "accessibility": "WhenUnlockedThisDeviceOnly",
        "accessControl": ["privateKeyUsage", "userPresence"],
        "algorithm": "ECDSA-SHA256-X9.62-DER",
        "signatureEncoding": "DER",
    ]
}

enum OperatorHelperError: Error {
    case invalidRequest
    case invalidEnvelope
    case frameTooLarge
    case invalidSocketPath
    case socketFailure
    case securityFailure
    case storedKeyDoesNotMatchProfile
    case staleChallenge
    case staleGeneration
}

private func consume(_ error: Unmanaged<CFError>?) {
    if let error = error {
        _ = error.takeRetainedValue()
    }
}

private func isSafeIdentifier(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard !bytes.isEmpty, bytes.count <= 128 else { return false }
    guard (bytes[0] >= 65 && bytes[0] <= 90) || (bytes[0] >= 97 && bytes[0] <= 122) || (bytes[0] >= 48 && bytes[0] <= 57) else {
        return false
    }
    return bytes.dropFirst().allSatisfy {
        ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 45 || $0 == 46 || $0 == 95 || $0 == 58
    }
}

private func isHexDigest(_ value: String) -> Bool {
    guard value.utf8.count == 64 else { return false }
    return value.utf8.allSatisfy {
        ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
    }
}

private func hexDigest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func canonicalJSON(_ object: [String: Any]) throws -> Data {
    guard JSONSerialization.isValidJSONObject(object) else { throw OperatorHelperError.invalidRequest }
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}

private func writeAll(_ descriptor: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { rawBuffer in
        guard let base = rawBuffer.baseAddress else { return }
        var offset = 0
        while offset < rawBuffer.count {
            let written = Darwin.write(descriptor, base.advanced(by: offset), rawBuffer.count - offset)
            if written > 0 {
                offset += written
                continue
            }
            if written < 0 && errno == EINTR { continue }
            throw OperatorHelperError.socketFailure
        }
    }
}

private func readBoundedFrame(_ descriptor: Int32) throws -> Data? {
    var frame = Data()
    var byte: UInt8 = 0
    while true {
        let count = Darwin.read(descriptor, &byte, 1)
        if count == 0 {
            if frame.isEmpty { return nil }
            throw OperatorHelperError.invalidRequest
        }
        if count < 0 {
            if errno == EINTR { continue }
            throw OperatorHelperError.socketFailure
        }
        if byte == 10 {
            if frame.last == 13 { frame.removeLast() }
            return frame
        }
        frame.append(byte)
        if frame.count > OperatorHelperContract.maxFrameBytes {
            repeat {
                let drained = Darwin.read(descriptor, &byte, 1)
                if drained <= 0 || byte == 10 { break }
            } while true
            throw OperatorHelperError.frameTooLarge
        }
    }
}

private final class SecureEnclaveOperatorKey {
    private let privateKey: SecKey
    let publicKeyDER: Data

    init() throws {
        self.privateKey = try Self.loadOrCreate()
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw OperatorHelperError.securityFailure
        }
        self.publicKeyDER = try Self.publicKeySubjectPublicKeyInfo(publicKey)
    }

    func sign(message: Data) throws -> Data {
        // .userPresence causes Security.framework to present Touch ID or the
        // device passcode on every operation. There is no bypass path.
        // The C API name is kSecKeyAlgorithmECDSASignatureMessageX962SHA256;
        // Swift 5 imports it as this typed enum case.
        let algorithm = SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256
        guard SecKeyIsAlgorithmSupported(privateKey, .sign, algorithm) else {
            throw OperatorHelperError.securityFailure
        }
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(privateKey, algorithm, message as CFData, &error) as Data? else {
            consume(error)
            throw OperatorHelperError.securityFailure
        }
        // This Security algorithm returns an ASN.1 DER/X9.62 ECDSA signature.
        guard !signature.isEmpty, signature.count <= 256 else {
            throw OperatorHelperError.securityFailure
        }
        return signature
    }

    private static func loadOrCreate() throws -> SecKey {
        var existing: CFTypeRef?
        let query: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrApplicationTag: OperatorHelperContract.keyTag,
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecUseDataProtectionKeychain: true,
            kSecReturnRef: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        let status = SecItemCopyMatching(query as CFDictionary, &existing)
        if status == errSecSuccess {
            guard let existing = existing else {
                throw OperatorHelperError.storedKeyDoesNotMatchProfile
            }
            let key = existing as! SecKey
            guard exactStoredKey(key) else {
                throw OperatorHelperError.storedKeyDoesNotMatchProfile
            }
            return key
        }
        guard status == errSecItemNotFound else {
            throw OperatorHelperError.securityFailure
        }

        var accessError: Unmanaged<CFError>?
        let accessFlags: SecAccessControlCreateFlags = [.privateKeyUsage, .userPresence]
        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            accessFlags,
            &accessError
        ) else {
            consume(accessError)
            throw OperatorHelperError.securityFailure
        }

        let privateAttributes: [CFString: Any] = [
            kSecAttrIsPermanent: true,
            kSecAttrApplicationTag: OperatorHelperContract.keyTag,
            kSecAttrAccessControl: accessControl,
        ]
        let attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits: 256,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecUseDataProtectionKeychain: true,
            kSecPrivateKeyAttrs: privateAttributes,
        ]
        var keyError: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &keyError) else {
            consume(keyError)
            // Deliberately do not substitute a software-generated key.
            throw OperatorHelperError.securityFailure
        }
        return key
    }

    private static func exactStoredKey(_ key: SecKey) -> Bool {
        guard SecKeyIsAlgorithmSupported(key, .sign, SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256) else {
            return false
        }
        guard let attributes = SecKeyCopyAttributes(key) as? [String: Any] else {
            return false
        }
        guard let keyType = attributes[kSecAttrKeyType as String] as? String,
              keyType == (kSecAttrKeyTypeECSECPrimeRandom as String),
              let keySize = attributes[kSecAttrKeySizeInBits as String] as? Int,
              keySize == 256,
              let keyClass = attributes[kSecAttrKeyClass as String] as? String,
              keyClass == (kSecAttrKeyClassPrivate as String),
              let tokenID = attributes[kSecAttrTokenID as String] as? String,
              tokenID == (kSecAttrTokenIDSecureEnclave as String) else {
            return false
        }
        return true
    }

    private static func publicKeySubjectPublicKeyInfo(_ publicKey: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        // Only the public SecKey is exported. Secure Enclave private bytes are
        // non-exportable and this helper never asks Security for them.
        guard let external = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            consume(error)
            throw OperatorHelperError.securityFailure
        }

        // Security returns an ANSI X9.63 P-256 point (04 || X || Y). Wrap it
        // in the fixed DER SubjectPublicKeyInfo envelope consumed by the host.
        let prefix = Data([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00])
        guard external.count == 65, external.first == 0x04 else {
            throw OperatorHelperError.securityFailure
        }
        return prefix + external
    }
}

private struct AdminEnvelope {
    let unsignedObject: [String: Any]
    let operation: String
    let challengeId: String
    let generationBefore: Int
    let challengeNonce: String
}

private enum ParsedRequest {
    case challenge(challengeId: String)
    case admin(AdminEnvelope)

    init(json: Data) throws {
        guard let object = try JSONSerialization.jsonObject(with: json, options: []) as? [String: Any], !object.isEmpty else {
            throw OperatorHelperError.invalidRequest
        }

        if object["protocol"] != nil {
            guard Set(object.keys).isSubset(of: ["protocol", "operation", "challengeId"]),
                  let protocolValue = object["protocol"] as? String,
                  protocolValue == OperatorHelperContract.protocolVersion,
                  let challengeId = object["challengeId"] as? String,
                  isSafeIdentifier(challengeId),
                  object["operation"] == nil || object["operation"] as? String == "challenge" else {
                throw OperatorHelperError.invalidRequest
            }
            self = .challenge(challengeId: challengeId)
            return
        }

        guard Set(object.keys) == OperatorHelperContract.adminRequestKeys,
              let protocolVersion = object["protocolVersion"] as? Int,
              protocolVersion == OperatorHelperContract.adminProtocolVersion,
              let operation = object["operation"] as? String,
              OperatorHelperContract.adminOperations.contains(operation),
              let literalArgv = object["literalArgv"] as? [String],
              let expectedArgv = OperatorHelperContract.adminLiteralArgv[operation],
              literalArgv == expectedArgv,
              let manifestDigest = object["manifestDigest"] as? String,
              isHexDigest(manifestDigest),
              let generationBefore = object["generationBefore"] as? Int,
              generationBefore >= 0,
              let challengeId = object["challengeId"] as? String,
              isSafeIdentifier(challengeId),
              let challengeNonce = object["challengeNonce"] as? String,
              isSafeIdentifier(challengeNonce),
              challengeNonce.utf8.count <= OperatorHelperContract.maxNonceBytes,
              let operatorProfile = object["operatorKeyProfile"] as? [String: Any],
              let operatorKeyId = object["operatorKeyId"] as? String,
              operatorKeyId == OperatorHelperContract.operatorKeyId,
              let publicKeyDigest = object["operatorPublicKeyDigest"] as? String,
              isHexDigest(publicKeyDigest),
              let helperDigest = object["operatorHelperDigest"] as? String,
              isHexDigest(helperDigest),
              (try? canonicalJSON(operatorProfile)) == Data(OperatorHelperContract.canonicalProfileJSON.utf8) else {
            throw OperatorHelperError.invalidEnvelope
        }

        self = .admin(AdminEnvelope(
            unsignedObject: object,
            operation: operation,
            challengeId: challengeId,
            generationBefore: generationBefore,
            challengeNonce: challengeNonce
        ))
    }
}

private final class OperatorHelper {
    private let key: SecureEnclaveOperatorKey
    private var lastAdminGeneration: Int?
    private var consumedAdminChallenges = Set<String>()

    init() throws {
        self.key = try SecureEnclaveOperatorKey()
    }

    func response(for requestData: Data) -> [String: Any] {
        do {
            switch try ParsedRequest(json: requestData) {
            case let .challenge(challengeId):
                return try challengeResponse(challengeId: challengeId)
            case let .admin(envelope):
                return try adminResponse(envelope)
            }
        } catch {
            // Never echo malformed input, key attributes, or Security errors.
            return [
                "protocol": OperatorHelperContract.protocolVersion,
                "ok": false,
                "error": "invalid_request",
            ]
        }
    }

    private func challengeResponse(challengeId: String) throws -> [String: Any] {
        let payload = Data("{\"challengeId\":\"\(challengeId)\",\"profile\":\(OperatorHelperContract.canonicalProfileJSON)}".utf8)
        let signature = try key.sign(message: payload)
        return baseResponse(operation: "challenge", challengeId: challengeId, signedPayload: payload, signature: signature)
    }

    private func adminResponse(_ envelope: AdminEnvelope) throws -> [String: Any] {
        guard lastAdminGeneration == nil || envelope.generationBefore >= lastAdminGeneration! else {
            throw OperatorHelperError.staleGeneration
        }
        let challengeKey = envelope.challengeId
        guard !consumedAdminChallenges.contains(challengeKey) else {
            throw OperatorHelperError.staleChallenge
        }
        guard let expectedPublicDigest = envelope.unsignedObject["operatorPublicKeyDigest"] as? String,
              expectedPublicDigest == hexDigest(key.publicKeyDER) else {
            throw OperatorHelperError.invalidEnvelope
        }

        // Sign every host-supplied canonical field. The helper never signs CLI
        // argv in isolation or invents a value omitted from the envelope.
        let canonical = try canonicalJSON(envelope.unsignedObject)
        let signature = try key.sign(message: canonical)
        consumedAdminChallenges.insert(challengeKey)
        lastAdminGeneration = max(lastAdminGeneration ?? envelope.generationBefore, envelope.generationBefore)

        var response = envelope.unsignedObject
        response["signature"] = signature.base64EncodedString()
        response["signerRole"] = "operator-helper"
        return response
    }

    private func baseResponse(operation: String, challengeId: String, signedPayload: Data, signature: Data) -> [String: Any] {
        var response: [String: Any] = [
            "protocol": OperatorHelperContract.protocolVersion,
            "ok": true,
            "operation": operation,
            "challengeId": challengeId,
            "helperUid": Int(getuid()),
            "userPresence": true,
            "profile": OperatorHelperContract.profile,
            "payloadDigest": hexDigest(signedPayload),
            "publicKeyDerBase64": key.publicKeyDER.base64EncodedString(),
            "signatureDerBase64": signature.base64EncodedString(),
        ]
        response["operatorKeyId"] = OperatorHelperContract.operatorKeyId
        response["operatorProfileId"] = OperatorHelperContract.operatorProfileId
        response["operatorKeyProfileDigest"] = hexDigest(Data(OperatorHelperContract.canonicalProfileJSON.utf8))
        response["operatorPublicKeyDigest"] = hexDigest(key.publicKeyDER)
        response["socketIdentity"] = OperatorHelperContract.socketIdentity
        response["attestationHook"] = OperatorHelperContract.attestationHook
        return response
    }
}

private final class UnixSocketServer {
    let descriptor: Int32
    private let path: String

    init(path: String) throws {
        let bytes = Array(path.utf8)
        guard !bytes.isEmpty,
              bytes.count + 1 <= OperatorHelperContract.maxSocketPathBytes,
              URL(fileURLWithPath: path).lastPathComponent == OperatorHelperContract.socketName else {
            throw OperatorHelperError.invalidSocketPath
        }
        self.path = path

        var address = sockaddr_un()
        let pathOffset = MemoryLayout<UInt8>.size + MemoryLayout<sa_family_t>.size
        let length = pathOffset + bytes.count + 1
        withUnsafeMutableBytes(of: &address) { raw in
            raw.initializeMemory(as: UInt8.self, repeating: 0)
            raw[0] = UInt8(length)
            raw[1] = UInt8(AF_UNIX)
            for (index, byte) in bytes.enumerated() {
                raw[pathOffset + index] = byte
            }
        }

        if path.withCString({ pointer in
            var info = stat()
            guard lstat(pointer, &info) == 0 else { return errno == ENOENT ? 0 : -1 }
            guard (info.st_mode & S_IFMT) == S_IFSOCK else { return -1 }
            return unlink(pointer)
        }) != 0 {
            throw OperatorHelperError.invalidSocketPath
        }

        let socketDescriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketDescriptor >= 0 else { throw OperatorHelperError.socketFailure }
        self.descriptor = socketDescriptor
        let bindStatus = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(socketDescriptor, $0, socklen_t(length))
            }
        }
        guard bindStatus == 0 else {
            Darwin.close(socketDescriptor)
            throw OperatorHelperError.socketFailure
        }
        guard path.withCString({ chmod($0, mode_t(S_IRUSR | S_IWUSR)) }) == 0,
              Darwin.listen(socketDescriptor, 8) == 0 else {
            Darwin.close(socketDescriptor)
            _ = path.withCString { unlink($0) }
            throw OperatorHelperError.socketFailure
        }
    }

    deinit {
        Darwin.close(descriptor)
        _ = path.withCString { unlink($0) }
    }

    func serve(_ helper: OperatorHelper) throws {
        while true {
            var address = sockaddr_un()
            var length = socklen_t(MemoryLayout<sockaddr_un>.size)
            let client = withUnsafeMutablePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.accept(descriptor, $0, &length)
                }
            }
            if client < 0 {
                if errno == EINTR { continue }
                throw OperatorHelperError.socketFailure
            }
            defer { Darwin.close(client) }
            var peerUID: uid_t = 0
            var peerGID: gid_t = 0
            guard getpeereid(client, &peerUID, &peerGID) == 0, peerUID == getuid() else {
                try? writeJSON(["protocol": OperatorHelperContract.protocolVersion, "ok": false, "error": "invalid_request"], to: client)
                continue
            }
            do {
                guard let frame = try readBoundedFrame(client) else { continue }
                try writeJSON(helper.response(for: frame), to: client)
            } catch {
                try? writeJSON(["protocol": OperatorHelperContract.protocolVersion, "ok": false, "error": "invalid_request"], to: client)
            }
        }
    }
}

private func writeJSON(_ object: [String: Any], to descriptor: Int32) throws {
    var data = try canonicalJSON(object)
    data.append(10)
    try writeAll(descriptor, data)
}

private func serveStdio(_ helper: OperatorHelper) throws {
    let descriptor = FileHandle.standardInput.fileDescriptor
    while true {
        do {
            guard let frame = try readBoundedFrame(descriptor) else { return }
            try writeJSON(helper.response(for: frame), to: FileHandle.standardOutput.fileDescriptor)
        } catch OperatorHelperError.frameTooLarge {
            try writeJSON(["protocol": OperatorHelperContract.protocolVersion, "ok": false, "error": "invalid_request"], to: FileHandle.standardOutput.fileDescriptor)
        }
    }
}

private func runOperatorHelper() {
    do {
        let helper = try OperatorHelper()
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.isEmpty {
            try serveStdio(helper)
        } else if arguments.count == 2, arguments[0] == "--socket" {
            let server = try UnixSocketServer(path: arguments[1])
            try server.serve(helper)
        } else {
            throw OperatorHelperError.invalidRequest
        }
    } catch {
        let message = Data("operator-helper unavailable\n".utf8)
        try? writeAll(FileHandle.standardError.fileDescriptor, message)
        Darwin.exit(1)
    }
}

runOperatorHelper()
