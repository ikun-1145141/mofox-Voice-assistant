import type * as PIXI from 'pixi.js';
import type { ModelMapping, SpeechSegment } from '@mofox/protocol';

interface LiveModel extends PIXI.Container {
  anchor: PIXI.ObservablePoint;
  internalModel: {
    coreModel: { setParameterValueById(id: string, value: number): void };
    on(event: string, callback: () => void): void;
  };
  expression(name: string): Promise<unknown>;
  motion(group: string, index?: number, priority?: number): Promise<unknown>;
}

let corePromise: Promise<void> | null = null;

async function ensureCore(): Promise<void> {
  if ('Live2DCubismCore' in window) return;
  if (!corePromise) corePromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/live2dcubismcore.min.js';
    script.onload = () => 'Live2DCubismCore' in window ? resolve() : reject(new Error('Cubism Core 文件没有提供 Live2DCubismCore 对象。'));
    script.onerror = () => { script.remove(); reject(new Error('请在设置中上传官方 Cubism Core，再载入角色。')); };
    document.head.append(script);
  }).catch(error => { corePromise = null; throw error; });
  await corePromise;
}

export class CharacterStage {
  private app: PIXI.Application | null = null;
  private model: LiveModel | null = null;
  private observer: ResizeObserver | null = null;
  private mouth = 0;
  private naturalSize = { width: 1, height: 1 };
  private generation = 0;
  private magnification = 1;
  private offsetY = 0;

  constructor(private container: HTMLElement, private mapping: () => ModelMapping) {}

  async load(entryUrl: string): Promise<void> {
    const generation = ++this.generation;
    this.clear();
    await ensureCore();
    const PIXI = await import('pixi.js');
    (window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
    const { Live2DModel } = await import('pixi-live2d-display/cubism4');
    const model = await Live2DModel.from(entryUrl, { autoInteract: false, motionPreload: 'NONE' }) as LiveModel;
    if (generation !== this.generation) { model.destroy(); return; }
    this.model = model;
    this.app = new PIXI.Application({
      antialias: true, backgroundAlpha: 0, autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2), resizeTo: this.container
    });
    this.container.append(this.app.view);
    this.app.stage.addChild(model);
    this.naturalSize = { width: model.width, height: model.height };
    model.anchor.set(0.5, 0.5);
    model.internalModel.on('beforeModelUpdate', () => {
      model.internalModel.coreModel.setParameterValueById(this.mapping().mouthParameter || 'ParamMouthOpenY', this.mouth);
    });
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.container);
    this.fit();
  }

  private fit(): void {
    if (!this.app || !this.model) return;
    const { clientWidth: width, clientHeight: height } = this.container;
    this.app.renderer.resize(width, height);
    const scale = Math.min(width * 0.88 / this.naturalSize.width, height * 0.92 / this.naturalSize.height);
    this.model.scale.set(scale * this.magnification);
    this.model.position.set(width / 2, height * (0.51 + this.offsetY));
  }

  transform(magnification: number, offsetY: number): void {
    this.magnification = magnification;
    this.offsetY = offsetY;
    this.fit();
  }

  amplitude(value: number): void { this.mouth = this.mouth * 0.35 + value * 0.65; }

  perform(segment: SpeechSegment): void {
    if (!this.model) return;
    const mapping = this.mapping();
    const emotion = segment.emotion && mapping.emotions[segment.emotion];
    const motion = segment.motion && mapping.motions[segment.motion];
    if (emotion) void this.model.expression(emotion).catch(() => undefined);
    if (motion) {
      const separator = motion.lastIndexOf(':');
      const group = separator >= 0 ? motion.slice(0, separator) : motion;
      const index = separator >= 0 ? Number(motion.slice(separator + 1)) || 0 : 0;
      void this.model.motion(group, index, 3).catch(() => undefined);
    }
  }

  private clear(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.model = null;
    this.app?.destroy(true, { children: true, texture: true, baseTexture: true });
    this.app = null;
    this.mouth = 0;
  }

  destroy(): void { ++this.generation; this.clear(); }
}
