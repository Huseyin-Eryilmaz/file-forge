/**
 * The drop target.
 *
 * Two details make browser drag-and-drop work at all.
 *
 * First, the default must be prevented on *both* `dragover` and `drop`.
 * Without the former the drop event never fires; without the latter the
 * browser navigates away to open the file, which is its default response
 * to a file being dropped on a page.
 *
 * Second, `dragleave` fires when the cursor crosses onto a child element,
 * not just when it leaves the zone. Tracking a boolean makes the
 * highlight flicker as the pointer moves over the text inside. Counting
 * enters and leaves instead gives a depth that only reaches zero when the
 * cursor has genuinely left.
 */

import { useState, useRef, type DragEvent, type ChangeEvent } from 'react';

interface DropZoneProps {
  onFile: (file: File) => void;
  disabled?: boolean;
}

export function DropZone({ onFile, disabled = false }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const depth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragEnter = (event: DragEvent) => {
    event.preventDefault();
    depth.current += 1;
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent) => {
    event.preventDefault();
    depth.current -= 1;
    if (depth.current <= 0) {
      depth.current = 0;
      setIsDragging(false);
    }
  };

  const handleDragOver = (event: DragEvent) => {
    // Required: without this the drop event never fires.
    event.preventDefault();
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    depth.current = 0;
    setIsDragging(false);
    if (disabled) return;

    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
  };

  const handleChoose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onFile(file);
    // Clear it, so choosing the same file twice still fires a change.
    event.target.value = '';
  };

  const classes = [
    'dropzone',
    isDragging && 'dropzone--active',
    disabled && 'dropzone--disabled',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.csv,text/csv"
        onChange={handleChoose}
        style={{ display: 'none' }}
        disabled={disabled}
      />
      <p className="dropzone__title">
        {isDragging ? 'Drop it' : 'Drop a file here'}
      </p>
      <p className="dropzone__hint">or click to choose — images or CSV</p>
    </div>
  );
}
