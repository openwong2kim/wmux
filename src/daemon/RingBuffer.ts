/**
 * Fixed-size circular byte buffer for storing ConPTY output per session.
 * Preserves raw bytes including ANSI escape sequences without any filtering.
 * When the buffer is full, the oldest data is overwritten.
 */
export class RingBuffer {
  private buffer: Buffer;
  private readonly capacity: number;
  private writePos: number;   // next write position (0..capacity-1)
  private length: number;     // bytes currently stored (<= capacity)

  constructor(capacityBytes: number) {
    if (capacityBytes <= 0 || !Number.isInteger(capacityBytes)) {
      throw new Error('capacityBytes must be a positive integer');
    }
    this.capacity = capacityBytes;
    this.buffer = Buffer.alloc(capacityBytes);
    this.writePos = 0;
    this.length = 0;
  }

  /**
   * Write data into the ring buffer.
   * If data exceeds capacity, only the last `capacity` bytes are preserved.
   */
  write(data: Buffer): void {
    const dataLen = data.length;
    if (dataLen === 0) return;

    // If incoming data is larger than capacity, only keep the tail
    if (dataLen >= this.capacity) {
      const offset = dataLen - this.capacity;
      data.copy(this.buffer, 0, offset, dataLen);
      this.writePos = 0;
      this.length = this.capacity;
      return;
    }

    // How much space from writePos to end of buffer
    const spaceToEnd = this.capacity - this.writePos;

    if (dataLen <= spaceToEnd) {
      // Fits without wrapping
      data.copy(this.buffer, this.writePos);
    } else {
      // Wraps around
      data.copy(this.buffer, this.writePos, 0, spaceToEnd);
      data.copy(this.buffer, 0, spaceToEnd, dataLen);
    }

    this.writePos = (this.writePos + dataLen) % this.capacity;
    this.length = Math.min(this.length + dataLen, this.capacity);
  }

  /**
   * Read all stored data in order (oldest first, newest last).
   * Returns a new Buffer copy; the internal buffer is not modified.
   */
  readAll(): Buffer {
    if (this.length === 0) {
      return Buffer.alloc(0);
    }

    if (this.length < this.capacity) {
      // Buffer has not wrapped yet; data is at [0..length)
      return Buffer.from(this.buffer.subarray(0, this.length));
    }

    // Buffer is full and has wrapped.
    // writePos points to the oldest byte (it's where the next write will go).
    // Order: [writePos..capacity) + [0..writePos)
    const tail = this.buffer.subarray(this.writePos, this.capacity);
    const head = this.buffer.subarray(0, this.writePos);
    return Buffer.concat([tail, head]);
  }

  /** Clear the buffer, resetting all pointers and zeroing sensitive data. */
  clear(): void {
    this.buffer.fill(0);
    this.writePos = 0;
    this.length = 0;
  }

  /** Number of bytes currently stored. */
  get size(): number {
    return this.length;
  }

  /** Total buffer capacity in bytes. */
  get totalCapacity(): number {
    return this.capacity;
  }

}
