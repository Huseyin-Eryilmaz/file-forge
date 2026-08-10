/**
 * Image processing, backed by sharp (libvips).
 *
 * Two things shape this module.
 *
 * First, **streams**. sharp can read from a stream and write to a stream,
 * so a large image never has to sit in memory in full. The alternative —
 * reading the whole file into a Buffer — works until several big uploads
 * arrive at once, at which point the process is holding hundreds of
 * megabytes for no good reason.
 *
 * Second, **content is the real validation**. The upload endpoint checked
 * a declared MIME type and a file extension, both of which a caller
 * controls and can get wrong or lie about. Here the bytes either decode
 * as an image or they do not: a `.png` that is really an executable fails
 * at this point, whatever it claimed to be.
 */

import sharp from 'sharp';
import type { Metadata, Sharp } from 'sharp';
import { z } from 'zod';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Processor, ProcessorArgs, ProcessorResult } from './processors.js';
import { MissingFileError, InvalidImageError } from './errors.js';


/**
 * Bounds on output dimensions.
 *
 * An unbounded resize is a denial-of-service waiting to happen: asking
 * for 50000x50000 from a small source costs enormous memory and time for
 * a result nobody wants.
 */
const MAX_DIMENSION = 8_000;
const MAX_THUMBNAIL = 512;

const ResizeOptionsSchema = z
  .object({
    width: z.coerce.number().int().min(1).max(MAX_DIMENSION).optional(),
    height: z.coerce.number().int().min(1).max(MAX_DIMENSION).optional(),
    /**
     * How the image fills the requested box. `inside` keeps the aspect
     * ratio and fits within the bounds, which is what people usually mean
     * by "make it smaller"; `cover` crops to fill exactly.
     */
    fit: z.enum(['cover', 'contain', 'fill', 'inside', 'outside']).default('inside'),
    /** Never scale a small image up — that invents detail that is not there. */
    withoutEnlargement: z.coerce.boolean().default(true),
  })
  .refine((options) => options.width !== undefined || options.height !== undefined, {
    message: 'Provide at least one of width or height',
  });

const ConvertOptionsSchema = z.object({
  format: z.enum(['jpeg', 'png', 'webp', 'avif']),
  quality: z.coerce.number().int().min(1).max(100).default(82),
});

const ThumbnailOptionsSchema = z.object({
  size: z.coerce.number().int().min(16).max(MAX_THUMBNAIL).default(256),
});

/** Extension to give an output, based on the format sharp produced. */
const FORMAT_EXTENSIONS: Record<string, string> = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  avif: '.avif',
  gif: '.gif',
  tiff: '.tiff',
};

function outputKey(originalKey: string, suffix: string, ext: string): string {
  const base = originalKey.replace(/^uploads\//, '').replace(extname(originalKey), '');
  return `outputs/${base}-${suffix}-${randomUUID().slice(0, 8)}${ext}`;
}

/**
 * Loads the source file and confirms it decodes as an image.
 *
 * Returns both the metadata and a factory for fresh streams. A stream can
 * only be consumed once, so reading metadata and then processing needs
 * two — hence handing back a function rather than a single stream.
 */
async function openImage({ payload, context }: ProcessorArgs) {
  const record = await context.files.get(payload.fileId);
  if (record === null) {
    throw new MissingFileError(payload.fileId);
  }

  const openStream = () => context.storage.open(record.storageKey);

  let metadata: Metadata;
  try {
    const probe = sharp();
    const source = await openStream();
    source.pipe(probe);
    metadata = await probe.metadata();
  } catch (error) {
    throw new InvalidImageError(
      error instanceof Error ? error.message : 'unreadable',
    );
  }

  if (!metadata.width || !metadata.height) {
    throw new InvalidImageError('no dimensions could be read');
  }

  return { record, metadata, openStream };
}

/**
 * Runs a sharp pipeline from storage to storage.
 *
 * The source stream feeds sharp, and sharp's output feeds straight back
 * into storage — no intermediate file, and no full copy in memory.
 */
async function runPipeline(
  args: ProcessorArgs,
  transform: Sharp,
  suffix: string,
  ext: string,
): Promise<{ key: string; size: number }> {
  const { payload, context, job } = args;
  const record = await context.files.get(payload.fileId);
  if (record === null) {
    throw new MissingFileError(payload.fileId);
  }

  const key = outputKey(record.storageKey, suffix, ext);
  const source = await context.storage.open(record.storageKey);

  await job.updateProgress(40);
  const stored = await context.storage.save(key, source.pipe(transform));
  await job.updateProgress(90);

  return { key: stored.key, size: stored.size };
}

export const resizeImage: Processor = async (args): Promise<ProcessorResult> => {
  const parsed = ResizeOptionsSchema.safeParse(args.payload.options);
  if (!parsed.success) {
    throw new Error(`Invalid resize options: ${parsed.error.issues[0]?.message}`);
  }
  const options = parsed.data;

  const { metadata } = await openImage(args);
  await args.job.updateProgress(20);

  const transform = sharp().resize({
    width: options.width,
    height: options.height,
    fit: options.fit,
    withoutEnlargement: options.withoutEnlargement,
  });

  const ext = FORMAT_EXTENSIONS[metadata.format ?? 'png'] ?? '.png';
  const output = await runPipeline(args, transform, 'resized', ext);

  // Read the real dimensions back rather than reporting what was asked
  // for: with `inside` fit and aspect ratio preserved, the result is
  // usually not exactly the requested box.
  const resultMeta = await sharp(
    await streamToBuffer(await args.context.storage.open(output.key)),
  ).metadata();

  await args.job.updateProgress(100);

  return {
    outputs: [output.key],
    details: {
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      width: resultMeta.width,
      height: resultMeta.height,
      format: resultMeta.format,
      bytes: output.size,
    },
  };
};

export const convertImage: Processor = async (args): Promise<ProcessorResult> => {
  const parsed = ConvertOptionsSchema.safeParse(args.payload.options);
  if (!parsed.success) {
    throw new Error(`Invalid convert options: ${parsed.error.issues[0]?.message}`);
  }
  const { format, quality } = parsed.data;

  const { metadata } = await openImage(args);
  await args.job.updateProgress(20);

  const transform = sharp().toFormat(format, { quality });
  const ext = FORMAT_EXTENSIONS[format] ?? '.bin';
  const output = await runPipeline(args, transform, format, ext);

  await args.job.updateProgress(100);

  return {
    outputs: [output.key],
    details: {
      sourceFormat: metadata.format,
      format,
      quality,
      bytes: output.size,
    },
  };
};

export const thumbnailImage: Processor = async (args): Promise<ProcessorResult> => {
  const parsed = ThumbnailOptionsSchema.safeParse(args.payload.options);
  if (!parsed.success) {
    throw new Error(`Invalid thumbnail options: ${parsed.error.issues[0]?.message}`);
  }
  const { size } = parsed.data;

  const { metadata } = await openImage(args);
  await args.job.updateProgress(20);

  // Thumbnails are always WebP: it is markedly smaller than JPEG or PNG
  // at the same visual quality, and a preview is the one place where
  // trading a little fidelity for size is obviously right.
  const transform = sharp()
    .resize({ width: size, height: size, fit: 'cover', position: 'centre' })
    .webp({ quality: 75 });

  const output = await runPipeline(args, transform, `thumb${size}`, '.webp');

  await args.job.updateProgress(100);

  return {
    outputs: [output.key],
    details: {
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      size,
      format: 'webp',
      bytes: output.size,
    },
  };
};

/** Collects a stream into a Buffer. Only used for small reads. */
async function streamToBuffer(
  stream: NodeJS.ReadableStream,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
