export const CONFIG = {
  appId: import.meta.env.VITE_PRIMUS_APP_ID,
  templateId: import.meta.env.VITE_PRIMUS_TEMPLATE_ID || "9e2dff87-3bfd-4a65-ad84-9eeb87d0f56e",
  signerUrl: (import.meta.env.VITE_SIGNER_URL || "http://localhost:8787").replace(/\/$/, ""),
  apostille: import.meta.env.VITE_APOSTILLE_ADDRESS,
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
  "function seal((address recipient,(string url,string header,string method,string body) request,(string keyName,string parseType,string parsePath)[] reponseResolve,string data,string attConditions,uint64 timestamp,string additionParams,(address attestorAddr,string url)[] attestors,bytes[] signatures) att) returns ((bytes32 accountHash,uint8 vipLevel,uint8 tier,uint64 issuedAt,uint64 expiresAt,uint128 spot30dVolume,uint128 futures30dVolume))",
  "function release()",
  "function tierOf(address wallet) view returns (bool active, uint8 tier, uint16 discountBps)",
  "function sealOf(address wallet) view returns ((bytes32 accountHash,uint8 vipLevel,uint8 tier,uint64 issuedAt,uint64 expiresAt,uint128 spot30dVolume,uint128 futures30dVolume))",
  "function tiers() view returns ((string name,uint8 minVipLevel,uint128 minFuturesVolume,uint16 feeDiscountBps)[])",
  "event Sealed(address indexed wallet, bytes32 indexed accountHash, uint8 tier, uint8 vipLevel, uint128 futures30dVolume, uint128 spot30dVolume, uint64 expiresAt)",
  "error RecipientMismatch(address recipient, address caller)",
  "error UnexpectedSource(string url)",
  "error UnexpectedField(string keyName)",
  "error StaleAttestation(uint64 timestampMs)",
  "error AttestationFromFuture(uint64 timestampMs)",
  "error ReplayedAttestation(uint64 timestampMs, uint64 lastTimestampMs)",
  "error AccountBoundElsewhere(address wallet)",
  "error NoActiveSeal(address wallet)",
  "error KeyNotFound(string key)",
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
  InvalidHex: "The Binance user id was not hashed. Start the proof again.",
};
