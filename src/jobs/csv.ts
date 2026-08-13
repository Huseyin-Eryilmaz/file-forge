/**
 * CSV processing, done as streams.
 *
 * This is the module the project exists to show off. A CSV can be
 * enormous, and the obvious implementation — read the file, parse it into
 * an array, work on the array, write the result — holds the entire thing
 * in memory twice over. At 500 MB that is not slow, it is fatal: the
 * process exceeds its heap limit and dies.
 *
 * So nothing here ever holds the whole file. Rows arrive one at a time
 * from the parser, pass through a transform, and leave through the
 * stringifier to storage. Memory stays flat whether the input is a
 * kilobyte or a gigabyte, because at any instant only a handful of rows
 * exist.
 *
 * `pipeline` wires the stages together. It matters for a reason beyond
 * tidiness: if any stage fails, it destroys all of them. Chaining `.pipe()`
 * by hand leaks file handles on error, and the leak only shows up under
 * load, long after it was introduced.
 */

import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Processor, ProcessorArgs, ProcessorResult } from './processors.js';
import {
  MissingFileError,
  InvalidCsvError,
  InvalidOptionsError,
} from './errors.js';


/**
 * A ceiling on row count.
 *
 * Not a memory concern — streaming handles that — but a time one. A file
 * with a hundred million rows would occupy a worker for hours, and a job
 * that never finishes is worse than one that fails quickly.
 */
const MAX_ROWS = 5_000_000;

const ValidateOptionsSchema = z.object({
  /** Treat the first row as headers. Almost always true for real files. */
  hasHeader: z.coerce.boolean().default(true),
  delimiter: z.string().length(1).default(','),
});

const TransformOptionsSchema = z.object({
  hasHeader: z.coerce.boolean().default(true),
  delimiter: z.string().length(1).default(','),
  /** Columns to keep, by name. Empty means keep everything. */
  columns: z.array(z.string()).default([]),
  /** Strip surrounding whitespace from every value. */
  trim: z.coerce.boolean().default(true),
  /** Drop rows where every kept value is empty. */
  dropEmptyRows: z.coerce.boolean().default(true),
});

interface ValidationReport {
  rows: number;
  columns: string[];
  columnCount: number;
  /** Rows whose field count differs from the header's. */
  inconsistentRows: number;
  /** First few inconsistent row numbers, for diagnosis. */
  inconsistentExamples: number[];
  /** Empty-value count per column. */
  emptyByColumn: Record<string, number>;
  emptyRows: number;
}

async function loadSource(args: ProcessorArgs): Promise<{
  openStream: () => Promise<Readable>;
  originalName: string;
  storageKey: string;
}> {
  const record = await args.context.files.get(args.payload.fileId);
  if (record === null) {
    throw new MissingFileError(args.payload.fileId);
  }
  return {
    openStream: () => args.context.storage.open(record.storageKey),
    originalName: record.originalName,
    storageKey: record.storageKey,
  };
}

function outputKey(originalName: string, suffix: string, ext: string): string {
  const base = originalName.replace(/\.[^.]+$/, '').slice(0, 40);
  return `outputs/${base}-${suffix}-${randomUUID().slice(0, 8)}${ext}`;
}

/**
 * Reads a CSV and reports on its shape, without keeping it.
 *
 * The counters are the only thing that grows, and they grow with the
 * number of *columns*, not rows — so the report costs the same for ten
 * rows as for ten million.
 */
export const validateCsv: Processor = async (
  args,
): Promise<ProcessorResult> => {
  const parsed = ValidateOptionsSchema.safeParse(args.payload.options);
  if (!parsed.success) {
    throw new InvalidOptionsError(
      `Invalid validate options: ${parsed.error.issues[0]?.message}`,
    );
  }
  const options = parsed.data;

  const { openStream, originalName } = await loadSource(args);

  const report: ValidationReport = {
    rows: 0,
    columns: [],
    columnCount: 0,
    inconsistentRows: 0,
    inconsistentExamples: [],
    emptyByColumn: {},
    emptyRows: 0,
  };

  const parser = parse({
    delimiter: options.delimiter,
    // Read rows as arrays, not objects: an inconsistent row is only
    // visible as a differing length, and object mode would quietly pad or
    // drop fields instead of reporting the mismatch.
    columns: false,
    relax_column_count: true,
    skip_empty_lines: false,
    bom: true,
  });

  let rowNumber = 0;
  const inspect = new Transform({
    objectMode: true,
    transform(row: string[], _encoding, callback) {
      rowNumber += 1;

      if (rowNumber === 1 && options.hasHeader) {
        report.columns = row.map((value) => value.trim());
        report.columnCount = row.length;
        for (const name of report.columns) {
          report.emptyByColumn[name] = 0;
        }
        callback();
        return;
      }

      if (report.columnCount === 0) {
        report.columnCount = row.length;
      }

      report.rows += 1;

      if (report.rows > MAX_ROWS) {
        callback(new InvalidCsvError(`more than ${MAX_ROWS} rows`));
        return;
      }

      if (row.length !== report.columnCount) {
        report.inconsistentRows += 1;
        if (report.inconsistentExamples.length < 5) {
          report.inconsistentExamples.push(rowNumber);
        }
      }

      let allEmpty = true;
      row.forEach((value, index) => {
        const empty = value.trim() === '';
        if (!empty) allEmpty = false;

        const name = report.columns[index];
        if (name !== undefined && empty) {
          report.emptyByColumn[name] = (report.emptyByColumn[name] ?? 0) + 1;
        }
      });
      if (allEmpty) {
        report.emptyRows += 1;
      }

      // Report progress occasionally rather than on every row: updating
      // Redis a million times would cost more than the parsing.
      if (report.rows % 50_000 === 0) {
        void args.job.updateProgress(50);
      }

      callback();
    },
  });

  await args.job.updateProgress(10);

  try {
    const source = await openStream();
    await pipeline(source, parser, inspect);
  } catch (error) {
    if (error instanceof InvalidCsvError) throw error;
    throw new InvalidCsvError(
      error instanceof Error ? error.message : 'unparseable',
    );
  }

  await args.job.updateProgress(80);

  // The report is small, so writing it as a whole is fine — this is the
  // one place where holding the result in memory is proportionate.
  const key = outputKey(originalName, 'report', '.json');
  const { Readable: ReadableStream } = await import('node:stream');
  const body = ReadableStream.from([JSON.stringify(report, null, 2)]);
  const stored = await args.context.storage.save(key, body);

  await args.job.updateProgress(100);

  return {
    outputs: [stored.key],
    details: {
      rows: report.rows,
      columns: report.columnCount,
      inconsistentRows: report.inconsistentRows,
      emptyRows: report.emptyRows,
    },
  };
};

/**
 * Rewrites a CSV: keep chosen columns, tidy the values.
 *
 * Every stage is a stream, so the output is being written while the input
 * is still being read. The file never exists in memory in either form.
 */
export const transformCsv: Processor = async (
  args,
): Promise<ProcessorResult> => {
  const parsed = TransformOptionsSchema.safeParse(args.payload.options);
  if (!parsed.success) {
    throw new InvalidOptionsError(
      `Invalid transform options: ${parsed.error.issues[0]?.message}`,
    );
  }
  const options = parsed.data;

  const { openStream, originalName } = await loadSource(args);

  const parser = parse({
    delimiter: options.delimiter,
    columns: options.hasHeader,
    trim: options.trim,
    skip_empty_lines: true,
    bom: true,
  });

  let kept = 0;
  let dropped = 0;
  let seen = 0;
  let selectedColumns: string[] = [];

  const reshape = new Transform({
    objectMode: true,
    transform(row: Record<string, string> | string[], _encoding, callback) {
      seen += 1;

      if (seen > MAX_ROWS) {
        callback(new InvalidCsvError(`more than ${MAX_ROWS} rows`));
        return;
      }

      // Without headers there is nothing to select by name, so the row
      // passes through as-is.
      if (Array.isArray(row)) {
        kept += 1;
        callback(null, row);
        return;
      }

      if (selectedColumns.length === 0) {
        const available = Object.keys(row);
        selectedColumns =
          options.columns.length > 0
            ? options.columns.filter((name) => available.includes(name))
            : available;

        if (options.columns.length > 0 && selectedColumns.length === 0) {
          callback(
            new InvalidCsvError(
              `none of the requested columns exist (available: ${available.join(', ')})`,
            ),
          );
          return;
        }
      }

      const output: Record<string, string> = {};
      let allEmpty = true;
      for (const name of selectedColumns) {
        const value = row[name] ?? '';
        const cleaned = options.trim ? value.trim() : value;
        if (cleaned !== '') allEmpty = false;
        output[name] = cleaned;
      }

      if (options.dropEmptyRows && allEmpty) {
        dropped += 1;
        callback();
        return;
      }

      kept += 1;
      if (kept % 50_000 === 0) {
        void args.job.updateProgress(50);
      }
      callback(null, output);
    },
  });

  await args.job.updateProgress(10);

  const key = outputKey(originalName, 'clean', '.csv');

  // The stringifier needs to know the column order up front for the
  // header row. It is resolved on the first row, which has already passed
  // through `reshape` by the time anything is written.
  const stringifier = stringify({
    header: options.hasHeader,
    columns: options.columns.length > 0 ? options.columns : undefined,
  });

  let stored;
  try {
    const source = await openStream();
    // Storage consumes the far end of the chain, so the whole pipeline
    // runs as one: read → parse → reshape → stringify → write.
    // All four stages in one pipeline, so an error in any of them — the
    // parser on malformed input, `reshape` on a missing column — rejects
    // here instead of leaving the write waiting for data that will never
    // arrive.
    stored = await args.context.storage.saveFrom(
      key,
      source,
      parser,
      reshape,
      stringifier,
    );
  } catch (error) {
    if (error instanceof InvalidCsvError) throw error;
    throw new InvalidCsvError(
      error instanceof Error ? error.message : 'unparseable',
    );
  }

  await args.job.updateProgress(100);

  return {
    outputs: [stored.key],
    details: {
      rowsIn: seen,
      rowsOut: kept,
      rowsDropped: dropped,
      columns: selectedColumns,
      bytes: stored.size,
    },
  };
};
