/// <reference types="vite/client" />

declare module 'pixi-live2d-display/cubism4' {
  export const Live2DModel: {
    from(url: string, options?: Record<string, unknown>): Promise<unknown>;
  };
}
