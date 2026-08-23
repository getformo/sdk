// The scenario table. Each entry names ONE behaviour, the mode and options
// that drive it, and the EXACT event list it must produce. Adding a behaviour
// to the SDK means adding a row here.
//
// Addresses are trimmed to 6 chars and shown after "/"; a user id after "#".
// A step absent from `expect` is not asserted, so a scenario can pin only the
// steps it is about.

const A = "0x5137", B = "0x88C0";

export const SCENARIOS = [
  // ── autocaptured wallet events, happy path ─────────────────────────────
  { name: "wagmi: full session", mode: "wagmi", expect: {
      connect: [`connect@1/${A}`], chainSwitch: [`chain@137/${A}`],
      signature: [`signature:requested@137/${A}`, `signature:confirmed@137/${A}`],
      transaction: [`transaction:started@137/${A}`, `transaction:broadcasted@137/${A}`],
      disconnect: [`disconnect@137/${A}`] } },
  { name: "eip1193: full session", mode: "eip1193", expect: {
      init: ["detect@-/-"], connect: [`connect@1/${A}`], chainSwitch: [`chain@137/${A}`],
      signature: [`signature:requested@137/${A}`, `signature:confirmed@137/${A}`],
      transaction: [`transaction:started@137/${A}`, `transaction:broadcasted@137/${A}`, `transaction:confirmed@137/${A}`],
      disconnect: [`disconnect@137/${A}`] } },

  // ── the regressions that started all this ──────────────────────────────
  { name: "wagmi: wallet connected BEFORE the SDK mounted still reports connect (#328)", mode: "wagmi", opts: { preConnect: true },
    expect: { "init(already connected)": [`connect@1/${A}`] } },
  { name: "wagmi: signature after an in-place account switch is attributed to the NEW account (#330)", mode: "wagmi", opts: { accountSwitch: true },
    expect: { signAfterSwitch: [`signature:requested@137/${B}`, `signature:confirmed@137/${B}`] } },
  { name: "wagmi: an explicit account on the mutation wins over the connected one (#330)", mode: "wagmi", opts: { explicitAccount: true },
    expect: { signExplicitAccount: [`signature:requested@137/${B}`, `signature:confirmed@137/${B}`] } },
  { name: "eip1193: a second wallet's signature is NOT labelled with the active wallet's chain (#329)", mode: "twowallets",
    expect: { signViaOther: [`signature:requested@0/${A}`, `signature:confirmed@0/${A}`] }, rpcMustNotInclude: ["eth_chainId"] },
  { name: "eip1193: a provider with no chain exposed reports 0, never a guess", mode: "cold",
    expect: { accountsChanged: [`connect@0/${A}`], signature: [`signature:requested@0/${A}`, `signature:confirmed@0/${A}`] } },
  { name: "eip1193: a provider whose eth_chainId fails still reports 0", mode: "unknownchain",
    expect: { signature: [`signature:requested@0/${A}`, `signature:confirmed@0/${A}`] } },

  // ── configuration: tracking ─────────────────────────────────────────────
  { name: "tracking:false sends nothing at all", mode: "wagmi", opts: { sdk: { tracking: false } }, expect: { all: [] } },
  { name: "excludeChains drops events on the excluded chain and keeps the rest", mode: "wagmi", opts: { sdk: { tracking: { excludeChains: [137] } } },
    expect: { connect: [`connect@1/${A}`], chainSwitch: [], signature: [], transaction: [], disconnect: [] } },
  { name: "excludeChains on the CONNECT chain suppresses the connect but not later allowed chains", mode: "wagmi", opts: { sdk: { tracking: { excludeChains: [1] } } },
    expect: { connect: [], chainSwitch: [`connect@137/${A}`], signature: [`signature:requested@137/${A}`, `signature:confirmed@137/${A}`] } },
  { name: "excludeHosts matching the page host sends nothing", mode: "wagmi", opts: { sdk: { tracking: { excludeHosts: ["example.com"] } } }, expect: { all: [] } },
  { name: "excludePaths matching the page path sends nothing", mode: "wagmi", opts: { sdk: { tracking: { excludePaths: ["/"] } } }, expect: { all: [] } },

  // ── configuration: autocapture ──────────────────────────────────────────
  { name: "autocapture:false sends no wallet events (page still goes)", mode: "wagmi", opts: { sdk: { autocapture: false } },
    expect: { connect: [], chainSwitch: [], signature: [], transaction: [], disconnect: [] } },
  { name: "autocapture.connect:false drops connect only", mode: "wagmi", opts: { sdk: { autocapture: { connect: false } } },
    expect: { connect: [], chainSwitch: [`chain@137/${A}`], disconnect: [`disconnect@137/${A}`] } },
  { name: "autocapture.disconnect:false drops disconnect only", mode: "wagmi", opts: { sdk: { autocapture: { disconnect: false } } },
    expect: { connect: [`connect@1/${A}`], disconnect: [] } },
  { name: "autocapture.chain:false drops chain only", mode: "wagmi", opts: { sdk: { autocapture: { chain: false } } },
    expect: { chainSwitch: [], signature: [`signature:requested@137/${A}`, `signature:confirmed@137/${A}`] } },
  { name: "autocapture.signature:false drops signatures only", mode: "wagmi", opts: { sdk: { autocapture: { signature: false } } },
    expect: { signature: [], transaction: [`transaction:started@137/${A}`, `transaction:broadcasted@137/${A}`] } },
  { name: "autocapture.transaction:false drops transactions only", mode: "wagmi", opts: { sdk: { autocapture: { transaction: false } } },
    expect: { signature: [`signature:requested@137/${A}`, `signature:confirmed@137/${A}`], transaction: [] } },
  { name: "eip1193: autocapture.signature:false still wraps the provider, so transactions are captured", mode: "eip1193", opts: { sdk: { autocapture: { signature: false } } },
    expect: { signature: [], transaction: [`transaction:started@137/${A}`, `transaction:broadcasted@137/${A}`, `transaction:confirmed@137/${A}`] } },

  // ── the public API, consent, and persistence ────────────────────────────
  { name: "api: identify carries the user id, and is deduped per session", mode: "api",
    expect: { identify: [`identify@-/${A}#user-1`], identifyAgain: [] } },
  { name: "api: track and page are attributed to the identified wallet and user", mode: "api",
    expect: { track: [`track(checkout_started)@-/${A}#user-1`], page: [`page@-/${A}#user-1`] } },
  { name: "api: nothing leaves while opted out, including an autocaptured signature", mode: "api",
    expect: { optedOut: [] } },
  { name: "api: opting back in resumes tracking with identity PURGED, not restored", mode: "api",
    expect: { optedIn: ["track(after_opt_in)@-/-"] } },
  { name: "api: reset clears wallet and user identity", mode: "api",
    expect: { afterReset: ["track(after_reset)@-/-"] }, state: { afterReset: { address: null, userId: null } } },
  { name: "api: a new instance restores the active wallet from the cookie before any wallet event", mode: "api",
    state: { reloadRestore: { address: "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf", chainId: 1 } } },
];
