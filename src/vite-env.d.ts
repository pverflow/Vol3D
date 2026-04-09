/// <reference types="vite/client" />

// Allow importing GLSL files as raw strings using ?raw suffix
declare module '*?raw' {
  const content: string
  export default content
}
