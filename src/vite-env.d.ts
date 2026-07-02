/// <reference types="vite/client" />

/** `vite/client`'s built-in asset module declarations only cover lowercase `*.png` - this covers the uppercase `.PNG` extension used by `src/assets/logo.PNG`. */
declare module "*.PNG" {
  const src: string;
  export default src;
}
