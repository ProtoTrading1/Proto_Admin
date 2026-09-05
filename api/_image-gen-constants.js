/** Shared image-gen limits — keep in a leaf module to avoid circular imports. */
export const MAX_CONCURRENT_TRANSFORMS = Math.max(
  1,
  Math.min(10, Number(process.env.IMAGE_GEN_CONCURRENCY) || 3),
);
