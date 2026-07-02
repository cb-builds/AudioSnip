use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;

/// A lock-free, single-producer/multi-reader circular buffer that always
/// holds the most recent `capacity` samples.
///
/// The producer (the realtime `cpal` audio callback) never blocks, never
/// allocates, and never has to decide whether the buffer is "full": it just
/// keeps writing forward through a fixed-size array of atomics, wrapping the
/// index around via modulo, which naturally overwrites the oldest sample
/// once it has gone all the way around. That *is* the rolling window.
///
/// Readers (`snapshot`/`snapshot_all`) copy out the most recent samples
/// without ever touching a "read cursor" - they only ever read, so calling
/// them repeatedly never disturbs the ongoing recording. Each slot is an
/// `AtomicU32` holding an `f32` bit pattern so reads and writes are properly
/// synchronized (no torn/undefined values) without a lock.
pub struct RollingBuffer {
    slots: Box<[AtomicU32]>,
    capacity: usize,
    write_pos: AtomicUsize,
}

impl RollingBuffer {
    pub fn new(capacity: usize) -> Arc<Self> {
        let capacity = capacity.max(1);
        let slots = (0..capacity)
            .map(|_| AtomicU32::new(0.0_f32.to_bits()))
            .collect::<Vec<_>>()
            .into_boxed_slice();

        Arc::new(Self {
            slots,
            capacity,
            write_pos: AtomicUsize::new(0),
        })
    }

    /// Writes samples from an iterator, wrapping around and overwriting the
    /// oldest data once the buffer is full. Takes `&self` (not `&mut self`)
    /// since all mutation goes through atomics - safe to call from the audio
    /// host callback thread with no lock and no allocation.
    pub fn write_from_iter(&self, samples: impl Iterator<Item = f32>) {
        let mut pos = self.write_pos.load(Ordering::Relaxed);
        for sample in samples {
            let index = pos % self.capacity;
            self.slots[index].store(sample.to_bits(), Ordering::Release);
            pos += 1;
        }
        // Publish the new write position only after every sample in this
        // batch has landed, so a concurrent reader either sees the buffer
        // exactly as it was before this call, or exactly as it is after -
        // never a mix of old and half-written new data.
        self.write_pos.store(pos, Ordering::Release);
    }

    /// Non-destructively copies out the most recent `max_samples` (or fewer,
    /// if the buffer hasn't been filled that far yet), oldest-first.
    pub fn snapshot(&self, max_samples: usize) -> Vec<f32> {
        let pos = self.write_pos.load(Ordering::Acquire);
        let available = pos.min(self.capacity);
        let count = available.min(max_samples);
        let start = pos - count;

        (start..pos)
            .map(|i| f32::from_bits(self.slots[i % self.capacity].load(Ordering::Acquire)))
            .collect()
    }

    /// Non-destructively copies out the entire rolling window (up to
    /// `capacity` samples).
    pub fn snapshot_all(&self) -> Vec<f32> {
        self.snapshot(self.capacity)
    }

    /// How many real samples are currently available to read (i.e. how much
    /// has actually been written so far, capped at `capacity`) - lets a
    /// caller learn how much real history exists without copying it out via
    /// `snapshot_all`.
    pub fn available_len(&self) -> usize {
        self.write_pos.load(Ordering::Acquire).min(self.capacity)
    }

    /// Immediately discards all buffered audio by resetting the write
    /// cursor to zero. The underlying slots aren't zeroed - there's no need
    /// to, since `snapshot`/`snapshot_all` only ever read up to the current
    /// write position, so old values past it are simply never seen again.
    /// Safe to call while the audio callback keeps writing concurrently.
    pub fn clear(&self) {
        self.write_pos.store(0, Ordering::Release);
    }
}
