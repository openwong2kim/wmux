// Vite resolves these imports to the bundled asset URL.
declare module '*.webm' {
  const url: string;
  export default url;
}
declare module '*.webp' {
  const url: string;
  export default url;
}
