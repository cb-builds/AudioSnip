use mp3lame_encoder::{Bitrate, Builder, FlushNoGap, MonoPcm, Quality};

/// Encodes mono PCM into a high-quality (320kbps CBR) MP3 using
/// `mp3lame-encoder` (LAME). `pcm` samples must be normalized to the
/// -1.0..=1.0 range, which is what `lame_encode_buffer_ieee_float` expects.
pub fn encode_mp3(pcm: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
    let mut builder = Builder::new().ok_or("failed to allocate LAME encoder")?;

    builder
        .set_num_channels(1)
        .map_err(|err| format!("failed to set channel count: {err}"))?;
    builder
        .set_sample_rate(sample_rate)
        .map_err(|err| format!("failed to set sample rate: {err}"))?;
    builder
        .set_brate(Bitrate::Kbps320)
        .map_err(|err| format!("failed to set bitrate: {err}"))?;
    builder
        .set_quality(Quality::Best)
        .map_err(|err| format!("failed to set quality: {err}"))?;

    let mut encoder = builder
        .build()
        .map_err(|err| format!("failed to initialize MP3 encoder: {err}"))?;

    let mut mp3_out = Vec::with_capacity(mp3lame_encoder::max_required_buffer_size(pcm.len()));
    encoder
        .encode_to_vec(MonoPcm(pcm), &mut mp3_out)
        .map_err(|err| format!("failed to encode audio: {err}"))?;
    encoder
        .flush_to_vec::<FlushNoGap>(&mut mp3_out)
        .map_err(|err| format!("failed to flush encoder: {err}"))?;

    println!(
        "[audio::encoder] encoded {} PCM samples into {} bytes of MP3",
        pcm.len(),
        mp3_out.len()
    );

    Ok(mp3_out)
}
