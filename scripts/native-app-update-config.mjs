// Native Sparkle release configuration. This module never reads private keys.
// The distinct appcast name prevents the Electron latest-mac.yml feed from
// being accidentally reused. Configuration is build-time, not an env override
// an arbitrary child process can use to redirect an installed app.
export function validateNativeUpdateConfig({ enabled, runtime, feedUrl, publicKey, bundleVersion, shortVersion }) {
  if (!enabled) return { enabled: false };
  if (runtime !== 'native-chromium') throw new Error('Native updates require the native-chromium runtime.');
  let url;
  try { url = new URL(feedUrl); } catch { throw new Error('Native update feed must be an HTTPS URL.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/native-appcast.xml')) {
    throw new Error('Native update feed must be HTTPS and end in /native-appcast.xml without credentials, query or fragment.');
  }
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(publicKey) || Buffer.from(publicKey, 'base64').length !== 32 || Buffer.from(publicKey, 'base64').toString('base64') !== publicKey) {
    throw new Error('Native update public key must be a canonical 32-byte Ed25519 public key.');
  }
  if (typeof bundleVersion !== 'string' || !/^[1-9][0-9]{0,14}$/.test(bundleVersion)) throw new Error('Native bundle version must be a positive monotonic integer.');
  if (typeof shortVersion !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(shortVersion)) throw new Error('Native release version must be a stable three-part version.');
  return { enabled: true, runtime, feedUrl: url.href, publicKey, bundleVersion, shortVersion };
}

// Release automation must compare against the last published native build.
export function assertNativeVersionAdvances(previousVersion, nextVersion) {
  const valid = value => typeof value === 'string' && /^[1-9][0-9]{0,14}$/.test(value);
  if (!valid(previousVersion) || !valid(nextVersion) || BigInt(nextVersion) <= BigInt(previousVersion)) {
    throw new Error('Native bundle version must advance beyond the published native release.');
  }
}
