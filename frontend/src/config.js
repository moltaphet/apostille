export const CONFIG = {
  // Public Primus app id (it ships in the bundle anyway); override with VITE_PRIMUS_APP_ID.
  appId: import.meta.env.VITE_PRIMUS_APP_ID || "0x97d782bfe1870c4ee29099bfcc8ebdda400e93eb",
  templateId: import.meta.env.VITE_PRIMUS_TEMPLATE_ID || "9e2dff87-3bfd-4a65-ad84-9eeb87d0f56e",
  signerUrl: (import.meta.env.VITE_SIGNER_URL || "/api").replace(/\/$/, ""),
  // Public testnet deployment; override with VITE_APOSTILLE_ADDRESS.
  apostille: import.meta.env.VITE_APOSTILLE_ADDRESS || "0x7EDa50410744a3e2B10a82016d8767f911cFD0B2",
};

export const CHAIN = {
  chainId: 97,
  hex: "0x61",
  params: {
    chainId: "0x61",
    chainName: "BNB Smart Chain Testnet",
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: ["https://data-seed-prebsc-1-s1.bnbchain.org:8545"],
    blockExplorerUrls: ["https://testnet.bscscan.com"],
  },
  explorer: "https://testnet.bscscan.com",
};

export const APOSTILLE_ABI = [
  "function seal((address recipient,(string url,string header,string method,string body) request,(string keyName,string parseType,string parsePath)[] reponseResolve,string data,string attConditions,uint64 timestamp,string additionParams,(address attestorAddr,string url)[] attestors,bytes[] signatures) att) returns ((bytes32 account,uint8 source,uint8 vipLevel,uint8 tier,bool concealed,uint64 issuedAt,uint64 expiresAt,uint128 spot30dVolume,uint128 futures30dVolume))",
  "function release()",
  "function tierOf(address wallet) view returns (bool active, uint8 tier, uint16 discountBps)",
  "function sealOf(address wallet) view returns ((bytes32 account,uint8 source,uint8 vipLevel,uint8 tier,bool concealed,uint64 issuedAt,uint64 expiresAt,uint128 spot30dVolume,uint128 futures30dVolume))",
  "function tiers() view returns ((string name,uint8 minVipLevel,uint128 minFuturesVolume,uint16 feeDiscountBps)[])",
  "function sources() view returns ((string name,string url,string idPath,string vipPath,string spotPath,string futuresPath,bool enabled)[])",
  "event Sealed(address indexed wallet, bytes32 indexed account, uint8 indexed source, uint8 tier, bool concealed, uint8 vipLevel, uint128 futures30dVolume, uint128 spot30dVolume, uint64 expiresAt)",
  "error RecipientMismatch(address recipient, address caller)",
  "error UnexpectedSource(string url)",
  "error UnexpectedField(string parsePath)",
  "error MissingField(string parsePath)",
  "error UnsupportedCondition(string op, string parsePath)",
  "error IdNotHashed(string parsePath)",
  "error StaleAttestation(uint64 timestampMs)",
  "error AttestationFromFuture(uint64 timestampMs)",
  "error ReplayedAttestation(uint64 timestampMs, uint64 lastTimestampMs)",
  "error AccountBoundElsewhere(address wallet)",
  "error NoActiveSeal(address wallet)",
  "error KeyNotFound(string key)",
  "error SealingPaused()",
  "error MalformedPayload()",
  "error InvalidNumber(string value)",
  "error InvalidHex(string value)",
];

/** Human explanations for contract errors, keyed by error name. */
export const ERROR_TEXT = {
  RecipientMismatch: "This proof was issued to a different wallet.",
  UnexpectedSource: "The proof did not come from Binance's VIP fee endpoint.",
  UnexpectedField: "The proof contains a field Apostille does not accept.",
  StaleAttestation: "The proof is older than 15 minutes. Generate a fresh one.",
  AttestationFromFuture: "The proof's timestamp is ahead of the chain clock. Check your system time.",
  ReplayedAttestation: "This proof (or a newer one) was already used for this Binance account.",
  AccountBoundElsewhere: "This Binance account already backs another wallet with an active seal.",
  NoActiveSeal: "This wallet has no seal to release.",
  InvalidHex: "The proof's account hash is malformed. Start the proof again.",
  IdNotHashed: "The Binance user ID wasn't hashed in this proof. Start the proof again.",
  MissingField: "The proof is missing a field Apostille needs. Start the proof again.",
  UnsupportedCondition: "The proof uses a condition Apostille doesn't accept.",
  SealingPaused: "New seals are paused right now. Existing seals still work. Try again later.",
  MalformedPayload: "The proof's data isn't in the shape Apostille expects. Start the proof again.",
};
