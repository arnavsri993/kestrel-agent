import Foundation
import CryptoKit
import LocalAuthentication
import Security

// Version 1: magic, big-endian representation length, representation checksum, opaque enclave key,
// ephemeral X9.63 P-256 public key, HKDF salt, GCM nonce, ciphertext, tag.
// The complete header and profile context are authenticated. No Keychain item
// APIs are used; CryptoKit/Security may themselves use system services.
private let magic = Data([0x4b, 0x53, 0x54, 0x56, 0x4c, 0x54, 0x01, 0x00])
private let maxEnvelope = 16384
private let maxContext = 4096
private let infoPrefix = Data("Kestrel local vault wrap v1\0".utf8)
private let fixedTail = 65 + 32 + 12 + 32 + 16
private let invalid: Int32 = 1
private let tooSmall: Int32 = 2
private let unavailable: Int32 = 3
private let cryptoFailure: Int32 = 4

private func clear(_ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int, _ limit: Int) {
    if let out = out, capacity > 0 { out.initialize(repeating: 0, count: min(capacity, limit)) }
}
private func random(_ count: Int) throws -> Data {
    var bytes = Data(count: count)
    let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
    guard status == errSecSuccess else { throw VaultError.failure }
    return bytes
}
private enum VaultError: Error { case failure }
private func contextData(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> Data? {
    guard let ptr = ptr, len > 0, len <= maxContext else { return nil }
    return Data(bytes: ptr, count: len)
}
private func localContext() -> LAContext {
    let context = LAContext()
    context.interactionNotAllowed = true
    return context
}
private func derived(_ secret: SharedSecret, _ salt: Data, _ context: Data) -> SymmetricKey {
    secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
                                  sharedInfo: infoPrefix + context, outputByteCount: 32)
}

@_cdecl("kestrel_vault_seal")
public func kestrelVaultSeal(_ contextPtr: UnsafePointer<UInt8>?, _ contextLen: Int,
                             _ key: UnsafePointer<UInt8>?, _ keyLen: Int,
                             _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int,
                             _ outLen: UnsafeMutablePointer<Int>?) -> Int32 {
    outLen?.pointee = 0
    guard let ctx = contextData(contextPtr, contextLen), let key = key,
          keyLen == 32, let out = out, capacity >= 0, let outLen = outLen else {
        clear(out, capacity, maxEnvelope); return invalid
    }
    guard SecureEnclave.isAvailable else { clear(out, capacity, maxEnvelope); return unavailable }
    do {
        let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, [], nil)
        guard let access = access else { throw VaultError.failure }
        let enclaveKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access, authenticationContext: localContext())
        let representation = enclaveKey.dataRepresentation
        guard representation.count > 0, representation.count <= maxEnvelope - 44 - fixedTail else { throw VaultError.failure }
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let pub = ephemeral.publicKey.x963Representation
        guard pub.count == 65 else { throw VaultError.failure }
        let salt = try random(32)
        let nonceData = try random(12)
        var header = magic
        let length = UInt32(representation.count)
        header.append(contentsOf: [UInt8((length >> 24) & 255), UInt8((length >> 16) & 255), UInt8((length >> 8) & 255), UInt8(length & 255)])
        header.append(contentsOf: SHA256.hash(data: representation))
        header.append(representation); header.append(pub); header.append(salt); header.append(nonceData)
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: enclaveKey.publicKey)
        var plain = Data(bytes: key, count: 32)
        defer { plain.resetBytes(in: 0..<plain.count) }
        let sealed = try AES.GCM.seal(plain, using: derived(shared, salt, ctx), nonce: AES.GCM.Nonce(data: nonceData), authenticating: header + ctx)
        let result = header + sealed.ciphertext + sealed.tag
        guard result.count <= maxEnvelope else { throw VaultError.failure }
        guard capacity >= result.count else { clear(out, capacity, maxEnvelope); return tooSmall }
        result.copyBytes(to: out, count: result.count)
        outLen.pointee = result.count
        return 0
    } catch { clear(out, capacity, maxEnvelope); return cryptoFailure }
}

@_cdecl("kestrel_vault_open")
public func kestrelVaultOpen(_ contextPtr: UnsafePointer<UInt8>?, _ contextLen: Int,
                             _ envelope: UnsafePointer<UInt8>?, _ envelopeLen: Int,
                             _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int,
                             _ outLen: UnsafeMutablePointer<Int>?) -> Int32 {
    outLen?.pointee = 0
    guard let ctx = contextData(contextPtr, contextLen), let envelope = envelope,
          envelopeLen >= 44 + fixedTail, envelopeLen <= maxEnvelope,
          let out = out, capacity >= 0, let outLen = outLen else {
        clear(out, capacity, 32); return invalid
    }
    guard capacity >= 32 else { clear(out, capacity, 32); return tooSmall }
    guard SecureEnclave.isAvailable else { clear(out, capacity, 32); return unavailable }
    do {
        let data = Data(bytes: envelope, count: envelopeLen)
        guard data.prefix(8) == magic else { throw VaultError.failure }
        let reprLen = (Int(data[8]) << 24) | (Int(data[9]) << 16) | (Int(data[10]) << 8) | Int(data[11])
        guard reprLen > 0, reprLen == envelopeLen - 44 - fixedTail else { throw VaultError.failure }
        let p = 44 + reprLen
        let headerEnd = p + 65 + 32 + 12
        let representation = data.subdata(in: 44..<p)
        // Detect accidental corruption before passing opaque bytes to CryptoKit.
        // This checksum is not a defense against deliberate recomputation.
        guard data.subdata(in: 12..<44) == Data(SHA256.hash(data: representation)) else { throw VaultError.failure }
        let pub = try P256.KeyAgreement.PublicKey(x963Representation: data.subdata(in: p..<(p + 65)))
        let salt = data.subdata(in: (p + 65)..<(p + 97))
        let nonce = try AES.GCM.Nonce(data: data.subdata(in: (p + 97)..<headerEnd))
        let enclaveKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: representation, authenticationContext: localContext())
        let secret = try enclaveKey.sharedSecretFromKeyAgreement(with: pub)
        let sealed = try AES.GCM.SealedBox(nonce: nonce, ciphertext: data.subdata(in: headerEnd..<(headerEnd + 32)), tag: data.suffix(16))
        var plain = try AES.GCM.open(sealed, using: derived(secret, salt, ctx), authenticating: data.prefix(headerEnd) + ctx)
        defer { plain.resetBytes(in: 0..<plain.count) }
        guard plain.count == 32 else { throw VaultError.failure }
        plain.copyBytes(to: out, count: 32)
        outLen.pointee = 32
        return 0
    } catch { clear(out, capacity, 32); return cryptoFailure }
}

@_cdecl("kestrel_vault_derive")
public func kestrelVaultDerive(_ contextPtr: UnsafePointer<UInt8>?, _ contextLen: Int,
                               _ master: UnsafePointer<UInt8>?, _ masterLen: Int,
                               _ purposePtr: UnsafePointer<UInt8>?, _ purposeLen: Int,
                               _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int,
                               _ outLen: UnsafeMutablePointer<Int>?) -> Int32 {
    outLen?.pointee = 0
    guard let context = contextData(contextPtr, contextLen), let master = master,
          masterLen == 32, let purposePtr = purposePtr, purposeLen > 0, purposeLen <= 64,
          let out = out, capacity >= 0, let outLen = outLen else {
        clear(out, capacity, 32); return invalid
    }
    let purpose = Data(bytes: purposePtr, count: purposeLen)
    guard purpose == Data("native-core-database/v1".utf8) || purpose == Data("chromium-oscrypt/v1".utf8) else {
        clear(out, capacity, 32); return invalid
    }
    guard capacity >= 32 else { clear(out, capacity, 32); return tooSmall }
    var info = Data("com.kestrel.local-vault.derive.v1".utf8)
    func appendLength(_ value: Int) {
        let n = UInt32(value)
        info.append(contentsOf: [UInt8((n >> 24) & 255), UInt8((n >> 16) & 255), UInt8((n >> 8) & 255), UInt8(n & 255)])
    }
    appendLength(context.count); info.append(context)
    appendLength(purpose.count); info.append(purpose)
    var masterData = Data(bytes: master, count: 32)
    defer { masterData.resetBytes(in: 0..<masterData.count) }
    let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: masterData), salt: Data(), info: info, outputByteCount: 32)
    key.withUnsafeBytes { bytes in out.update(from: bytes.bindMemory(to: UInt8.self).baseAddress!, count: 32) }
    outLen.pointee = 32
    return 0
}
