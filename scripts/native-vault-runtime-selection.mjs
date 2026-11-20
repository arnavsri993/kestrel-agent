export const VAULT_CEF_RUNTIME_ENV = "KESTREL_NATIVE_VAULT_CEF_RUNTIME";
const option = "--vault-cef-runtime";

// Selection only. The runtime validator must still inspect the actual local
// distribution before any cache preparation, build, download or profile access.
export function selectNativeVaultRuntime({ explicit, argv = process.argv.slice(2), env = process.env } = {}) {
 const checked = value => {
  if (typeof value !== "string" || value.length === 0)
   throw Error("A selected vault-enabled CEF distribution path must be a nonempty string.");
  return value;
 };
 if (explicit !== undefined) return checked(explicit);
 const choices = [];
 for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === option) {
   const value = argv[++i];
   if (value === undefined || value.startsWith("--")) throw Error(`${option} requires a distribution path.`);
   choices.push(checked(value));
  } else if (arg.startsWith(`${option}=`)) {
   choices.push(checked(arg.slice(option.length + 1)));
  }
 }
 if (choices.length > 1) throw Error(`Specify ${option} only once.`);
 if (choices.length) return choices[0];
 return env[VAULT_CEF_RUNTIME_ENV] === undefined ? undefined : checked(env[VAULT_CEF_RUNTIME_ENV]);
}
