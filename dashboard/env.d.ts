/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" when the app runs against the in-browser mock API (`npm run dev:mock`, `vite --mode mock`). */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
