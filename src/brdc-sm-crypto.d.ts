declare module "brdc-sm-crypto" {
  const crypto: {
    readonly sm3: (input: string | Uint8Array) => string
  }
  export default crypto
}
