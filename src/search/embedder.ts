import type { FeatureExtractor } from "./runtime.js";
import { MODEL, loadTransformers } from "./runtime.js";

export interface Embedder {
  readonly model: string;
  // Unit-length vectors, one per text, so cosine similarity is a dot product.
  embed(texts: string[]): Promise<Float32Array[]>;
}

export class TransformersEmbedder implements Embedder {
  readonly model = MODEL;
  private extractor: Promise<FeatureExtractor> | null = null;

  constructor(private onProgress?: (p: { file?: string; progress?: number; status: string }) => void) {}

  load(): Promise<FeatureExtractor> {
    this.extractor ??= loadTransformers().then((tf) => tf.pipeline("feature-extraction", MODEL, { dtype: "q8", progress_callback: this.onProgress }));
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const extract = await this.load();
    const out = await extract(texts, { pooling: "mean", normalize: true });
    return out.tolist().map((v) => Float32Array.from(v));
  }
}
