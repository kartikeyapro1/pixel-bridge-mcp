import type { CostEstimate } from '../core/budget.js';

export type ImageQuality = 'low' | 'medium' | 'high' | 'auto';
export type ImageBackground = 'transparent' | 'opaque' | 'auto';
export type ImageFormat = 'png' | 'webp' | 'jpeg';

export interface ImageParams {
  model: string;
  prompt: string;
  size: string; // "1024x1024" | "auto" | custom WxH
  quality: ImageQuality;
  background: ImageBackground;
  outputFormat: ImageFormat;
  n: number;
}

export interface InputImage {
  data: Buffer;
  filename: string;
  mime: string;
}

export interface ImageEditParams extends ImageParams {
  images: InputImage[];
  mask?: InputImage;
  inputFidelity?: 'high' | 'low';
}

export interface GeneratedImage {
  data: Buffer;
  format: ImageFormat;
}

export interface ImageResult {
  images: GeneratedImage[];
  /** Cost computed from provider-reported usage; null if the provider did not report usage. */
  actualCostUsd: number | null;
  usage?: Record<string, unknown>;
}

export interface ImageCapabilities {
  models: string[];
  defaultModel: string;
  edit: boolean;
  maxReferenceImages: number;
  transparentBackground: 'supported' | 'preview' | 'unsupported' | 'model-dependent';
  sizes: string[];
  customSizes: boolean;
  notes: string[];
}

export interface ImageProvider {
  readonly id: string;
  capabilities(): ImageCapabilities;
  estimate(params: ImageParams, operation: 'generate' | 'edit', referenceCount: number): CostEstimate;
  validate(params: ImageParams, operation: 'generate' | 'edit'): void;
  generate(params: ImageParams): Promise<ImageResult>;
  edit(params: ImageEditParams): Promise<ImageResult>;
}

// ---- async job providers (video, image-to-3D) -----------------------------

export type JobKind = 'video' | '3d';

export interface JobSubmitParams {
  kind: JobKind;
  model: string;
  prompt?: string;
  image?: InputImage;
  durationSeconds?: number;
  extraInput?: Record<string, unknown>;
}

/** Opaque state persisted in the jobs table so a restarted server can resume. Never contains credentials. */
export type ProviderJobState = Record<string, string>;

export type RemoteStatus =
  | { status: 'queued'; position?: number }
  | { status: 'running'; progress?: number }
  | { status: 'completed' }
  | { status: 'failed'; error: string };

export interface JobOutputFile {
  url: string;
  ext: string;
  role: string;
}

export interface JobProvider {
  readonly id: string;
  supports(kind: JobKind, model: string): boolean;
  describeModels(): { model: string; kind: JobKind; priced: boolean; pricing?: unknown }[];
  estimate(params: JobSubmitParams): CostEstimate;
  validate(params: JobSubmitParams): void;
  submit(params: JobSubmitParams): Promise<{ remoteId: string; state: ProviderJobState }>;
  poll(state: ProviderJobState): Promise<RemoteStatus>;
  outputs(
    state: ProviderJobState,
    kind: JobKind,
  ): Promise<{ files: JobOutputFile[]; actualCostUsd: number | null }>;
  download(url: string, maxBytes: number): Promise<Buffer>;
  cancel(state: ProviderJobState): Promise<'cancelled' | 'requested' | 'too_late' | 'not_found'>;
}
