/**
 * Inference Module — Native Node.js visual AI inference.
 *
 * Replaces the Python woobury_models.serve dependency with an
 * in-process ONNX Runtime inference server. Same HTTP API,
 * no Python required.
 */

export { ElementMatcher, dotProduct } from './element-matcher.js';
export { ModelCache } from './model-cache.js';
export {
  startInferenceServer,
  stopInferenceServer,
  type InferenceServer,
} from './serve.js';
export {
  decodeBase64Image,
  cropRegion,
  preprocessImage,
  MAX_SIDE,
  IMAGENET_MEAN,
  IMAGENET_STD,
  type Bounds,
} from './image-utils.js';
