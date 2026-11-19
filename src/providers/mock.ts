import type { CostEstimate } from '../core/budget.js';
import { sha256 } from '../core/hashing.js';
import { encodePng } from '../util/png.js';
import type {
  ImageCapabilities,
  ImageEditParams,
  ImageParams,
  ImageProvider,
  ImageResult,
  JobKind,
  JobOutputFile,
  JobProvider,
  JobSubmitParams,
  ProviderJobState,
  RemoteStatus,
} from './types.js';

/**
 * Offline providers for tests, CI and demos. They produce real (but trivial) files
 * and charge a configurable fake cost so budget logic is exercised end to end.
 * Outputs are tagged `mock: true` in asset metadata.
 */

function colourFor(prompt: string): [number, number, number] {
  const h = sha256(prompt);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** A simple silhouette (head + body) so Blender reference planes have something to show. */
export function mockCharacterPng(prompt: string, width = 256, height = 384): Buffer {
  const [r, g, b] = colourFor(prompt);
  const cx = width / 2;
  return encodePng(width, height, (x, y) => {
    const head = (x - cx) ** 2 + (y - height * 0.28) ** 2 < (width * 0.22) ** 2;
    const body = Math.abs(x - cx) < width * 0.18 && y > height * 0.45 && y < height * 0.92;
    return head || body ? [r, g, b, 255] : [235, 235, 235, 255];
  });
}

export class MockImageProvider implements ImageProvider {
  readonly id = 'mock';
  calls: { op: string; params: ImageParams }[] = [];

  constructor(private readonly costPerCall: number) {}

  capabilities(): ImageCapabilities {
    return {
      models: ['mock-image'],
      defaultModel: 'mock-image',
      edit: true,
      maxReferenceImages: 16,
      transparentBackground: 'supported',
      sizes: ['auto', '1024x1024', '1024x1536', '1536x1024'],
      customSizes: true,
      notes: ['Offline mock provider: produces placeholder PNGs. Not real generation.'],
    };
  }

  validate(): void {}

  estimate(p: ImageParams, operation: 'generate' | 'edit'): CostEstimate {
    return {
      provider: this.id,
      model: p.model,
      operation: `image.${operation}`,
      estimatedUsd: this.costPerCall * p.n,
      basis: 'mock provider fixed cost',
    };
  }

  async generate(p: ImageParams): Promise<ImageResult> {
    this.calls.push({ op: 'generate', params: p });
    return this.result(p);
  }

  async edit(p: ImageEditParams): Promise<ImageResult> {
    this.calls.push({ op: 'edit', params: p });
    return this.result(p);
  }

  private result(p: ImageParams): ImageResult {
    const images = Array.from({ length: p.n }, (_, i) => ({
      data: mockCharacterPng(`${p.prompt}#${i}`),
      format: 'png' as const,
    }));
    return { images, actualCostUsd: this.costPerCall * p.n };
  }
}

/** Mock async job provider: completes after `pollsUntilDone` status checks. */
export class MockJobProvider implements JobProvider {
  readonly id = 'mock';
  private polls = new Map<string, number>();
  cancelled = new Set<string>();

  constructor(
    private readonly costPerCall: number,
    private readonly pollsUntilDone = 2,
    private readonly failModels = new Set<string>(),
  ) {}

  supports(): boolean {
    return true;
  }

  describeModels() {
    return [
      { model: 'mock-video', kind: 'video' as const, priced: true },
      { model: 'mock-3d', kind: '3d' as const, priced: true },
    ];
  }

  validate(): void {}

  estimate(p: JobSubmitParams): CostEstimate {
    return {
      provider: this.id,
      model: p.model,
      operation: `${p.kind}.generate`,
      estimatedUsd: this.costPerCall,
      basis: 'mock provider fixed cost',
    };
  }

  async submit(p: JobSubmitParams): Promise<{ remoteId: string; state: ProviderJobState }> {
    const id = `mock-${sha256(`${p.model}${p.prompt}${Date.now()}${Math.random()}`).slice(0, 12)}`;
    this.polls.set(id, 0);
    return { remoteId: id, state: { requestId: id, model: p.model, kind: p.kind } };
  }

  async poll(state: ProviderJobState): Promise<RemoteStatus> {
    const id = state.requestId!;
    if (this.cancelled.has(id)) return { status: 'failed', error: 'cancelled' };
    const n = (this.polls.get(id) ?? this.pollsUntilDone) + 1;
    this.polls.set(id, n);
    if (n < this.pollsUntilDone)
      return { status: 'running', progress: Math.round((n / this.pollsUntilDone) * 100) };
    if (this.failModels.has(state.model!)) return { status: 'failed', error: 'mock failure' };
    return { status: 'completed' };
  }

  async outputs(
    state: ProviderJobState,
    kind: JobKind,
  ): Promise<{ files: JobOutputFile[]; actualCostUsd: number | null }> {
    const ext = kind === 'video' ? 'mp4' : 'glb';
    return {
      files: [{ url: `mock://${state.requestId}.${ext}`, ext, role: kind }],
      actualCostUsd: this.costPerCall,
    };
  }

  async download(url: string): Promise<Buffer> {
    return Buffer.from(`PIXELBRIDGE MOCK OUTPUT ${url}\n`, 'utf8');
  }

  async cancel(state: ProviderJobState): Promise<'cancelled'> {
    this.cancelled.add(state.requestId!);
    return 'cancelled';
  }
}
