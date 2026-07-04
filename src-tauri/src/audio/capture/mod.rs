pub mod process_loopback;
pub mod wasapi;

use std::sync::Arc;

use crate::audio::ring_buffer::RollingBuffer;

/// Whether a channel is a real microphone/line input, a loopback capture of
/// an output/render device (speakers, GoXLR virtual channels, etc), or a
/// user-added application-specific source (captured via process-loopback,
/// see `process_loopback.rs`).
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKind {
    Input,
    Output,
    Application,
}

/// Describes a capturable audio channel/device discovered on the host.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub id: String,
    pub name: String,
    pub kind: ChannelKind,
    /// A `data:image/png;base64,...` icon, populated only for
    /// `ChannelKind::Application` entries (see `apps::ApplicationSource`).
    pub icon_base64: Option<String>,
}

/// Negotiated format of an opened capture stream. Needed downstream for
/// time-based trim/fade math and resampling before mixdown.
#[derive(Debug, Clone, Copy)]
pub struct StreamFormat {
    pub sample_rate: u32,
    pub channels: u16,
}

/// Platform-specific audio capture backend. The Windows (WASAPI loopback via
/// `cpal`) implementation lives in `wasapi.rs`; a future Linux backend can
/// implement this trait without touching shared mixing/export/UI code.
pub trait CaptureBackend {
    fn list_channels(&self) -> Vec<ChannelInfo>;
    fn start_capture(
        &mut self,
        channel_id: &str,
        buffer: Arc<RollingBuffer>,
    ) -> Result<StreamFormat, String>;
    fn stop_capture(&mut self, channel_id: &str) -> Result<(), String>;
}
