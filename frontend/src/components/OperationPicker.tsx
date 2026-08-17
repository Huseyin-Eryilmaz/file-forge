/**
 * Choosing what to do with the uploaded file.
 *
 * Only operations that apply to the file's kind are offered. Showing
 * "Resize" for a CSV would be an invitation to queue a job that can only
 * fail — better to make the impossible unselectable than to explain the
 * failure afterwards.
 *
 * The option fields change with the operation, because they genuinely
 * differ: a resize needs a width, a conversion needs a format. Rendering
 * every field at once and ignoring the irrelevant ones would leave the
 * user guessing which apply.
 */

import { useState } from 'react';
import {
  OPERATIONS_BY_KIND,
  OPERATION_LABELS,
  type Operation,
} from '@contract';

interface OperationPickerProps {
  kind: 'image' | 'csv';
  disabled: boolean;
  onRun: (operation: Operation, options: Record<string, unknown>) => void;
}

export function OperationPicker({
  kind,
  disabled,
  onRun,
}: OperationPickerProps) {
  const available = OPERATIONS_BY_KIND[kind];
  const [operation, setOperation] = useState<Operation>(available[0]);
  const [width, setWidth] = useState('800');
  const [format, setFormat] = useState('webp');
  const [size, setSize] = useState('256');
  const [columns, setColumns] = useState('');

  const buildOptions = (): Record<string, unknown> => {
    switch (operation) {
      case 'image.resize':
        return { width: Number(width) };
      case 'image.convert':
        return { format };
      case 'image.thumbnail':
        return { size: Number(size) };
      case 'csv.transform':
        return columns.trim()
          ? {
              columns: columns
                .split(',')
                .map((name) => name.trim())
                .filter(Boolean),
            }
          : {};
      default:
        return {};
    }
  };

  return (
    <section className="card">
      <h2>What should happen?</h2>

      <div className="field">
        <label htmlFor="operation">Operation</label>
        <select
          id="operation"
          value={operation}
          onChange={(event) => setOperation(event.target.value as Operation)}
          disabled={disabled}
        >
          {available.map((op) => (
            <option key={op} value={op}>
              {OPERATION_LABELS[op]}
            </option>
          ))}
        </select>
      </div>

      {operation === 'image.resize' && (
        <div className="field">
          <label htmlFor="width">Width (px)</label>
          <input
            id="width"
            type="number"
            min="1"
            max="8000"
            value={width}
            onChange={(event) => setWidth(event.target.value)}
            disabled={disabled}
          />
        </div>
      )}

      {operation === 'image.convert' && (
        <div className="field">
          <label htmlFor="format">Format</label>
          <select
            id="format"
            value={format}
            onChange={(event) => setFormat(event.target.value)}
            disabled={disabled}
          >
            <option value="webp">WebP</option>
            <option value="jpeg">JPEG</option>
            <option value="png">PNG</option>
            <option value="avif">AVIF</option>
          </select>
        </div>
      )}

      {operation === 'image.thumbnail' && (
        <div className="field">
          <label htmlFor="size">Size (px)</label>
          <input
            id="size"
            type="number"
            min="16"
            max="512"
            value={size}
            onChange={(event) => setSize(event.target.value)}
            disabled={disabled}
          />
        </div>
      )}

      {operation === 'csv.transform' && (
        <div className="field">
          <label htmlFor="columns">Columns to keep</label>
          <input
            id="columns"
            type="text"
            placeholder="empty for all — e.g. city, temperature_c"
            value={columns}
            onChange={(event) => setColumns(event.target.value)}
            disabled={disabled}
          />
        </div>
      )}

      <button
        type="button"
        className="button"
        onClick={() => onRun(operation, buildOptions())}
        disabled={disabled}
      >
        Run
      </button>
    </section>
  );
}
