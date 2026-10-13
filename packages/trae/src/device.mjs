// Trae: the device an account signs in from — its ids, its P-256 key, and the proof a renewal signs with it.
import { generateKeyPairSync, randomBytes, randomInt, sign } from "node:crypto"

const digits = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? randomInt(1, 10) : randomInt(0, 10))).join("")

// newDeviceKey is the device's key pair, an ECDSA P-256 one as the clients
// keep (iCubeAuthInfo://icube-dc:<device>), whose public half goes with a
// renewal and whose private half signs it (DeviceProof). An account signed
// in before 0.2.3 has none and is given one at its next renewal.
export function newDeviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  return {
    devicePublicKey: publicKey.export({ type: "spki", format: "pem" }),
    devicePrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
  }
}

// device is the machine an account signs in from, made once at sign-in and
// named to trae.cn's authorization page, then sent with every request: a
// fresh one each time is what the relays saw requests dropped for.
export const newDevice = () => ({ deviceId: digits(19), machineId: randomBytes(16).toString("hex"), ...newDeviceKey() })

// proofOf is a renewal's DeviceProof: the device key's ECDSA-SHA256
// signature (DER, base64) of the method, path, client, refresh token, time
// and nonce, one to a line, as the clients sign it
export function proofOf(path, clientId, refresh, privateKey, at = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString("hex")) {
  const text = ["POST", path, clientId, refresh, String(at), nonce].join("\n")
  return { Signature: sign("sha256", Buffer.from(text), privateKey).toString("base64"), Timestamp: at, Nonce: nonce }
}

// deviceInfo is the device a renewal names, its public key with it
export function deviceInfo(a, as, site) {
  return {
    DeviceID: a.deviceId,
    MachineID: a.machineId,
    PlatformCode: as.platform,
    DeviceType: "PC",
    DeviceName: "",
    DeviceModel: "",
    ClientVersion: as.version,
    DevicePublicKey: a.devicePublicKey,
    DeviceBrand: site.brand,
    DeviceCPU: "AMD",
    OSInfo: "Windows",
    OSVersion: "10.0.22631",
  }
}
