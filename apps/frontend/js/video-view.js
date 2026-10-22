import { onStateUpdate } from './state.js?v=20261015-7';

let selectedUavId = null;
let activeStreamKey = '';
let lastListSignature = '';
let failedStreamKey = '';

export function initVideoView() {
  onStateUpdate(renderVideoView);
}

function renderVideoView(vehicles) {
  const list = document.getElementById('video-uav-list');
  const count = document.getElementById('video-uav-count');
  const title = document.getElementById('video-title');
  const subtitle = document.getElementById('video-subtitle');
  const badge = document.getElementById('video-connection-badge');
  const emptyTitle = document.getElementById('video-empty-title');
  const emptyMessage = document.getElementById('video-empty-message');
  const emptyState = document.getElementById('video-empty-state');
  const image = document.getElementById('uav-camera-image');
  const video = document.getElementById('uav-camera-video');
  const streamLabel = document.getElementById('video-stream-label');
  streamLabel.textContent = 'CAMERA FEED';

  count.textContent = `${vehicles.length} ${vehicles.length === 1 ? 'vehicle' : 'vehicles'}`;
  if (!vehicles.some((vehicle) => vehicle.uav_id === selectedUavId)) {
    selectedUavId = vehicles[0]?.uav_id ?? null;
  }

  const listSignature = JSON.stringify(vehicles.map(({ uav_id, connected, camera_url }) => ({
    uav_id,
    connected,
    camera_url,
    selected: uav_id === selectedUavId,
  })));
  if (listSignature !== lastListSignature) {
    lastListSignature = listSignature;
    list.innerHTML = vehicles.map((vehicle) => {
      const status = !vehicle.connected ? 'Offline' : vehicle.camera_url ? 'Camera ready' : 'No camera URL';
      return `<button type="button" class="video-uav-item ${vehicle.uav_id === selectedUavId ? 'active' : ''}"
        data-video-uav="${escapeHtml(vehicle.uav_id)}" aria-pressed="${vehicle.uav_id === selectedUavId}">
        <span class="video-uav-indicator ${vehicle.connected ? 'connected' : ''}" aria-hidden="true"></span>
        <span class="video-uav-copy"><strong>${escapeHtml(vehicle.uav_id)}</strong><small>${status}</small></span>
        <span class="video-uav-arrow" aria-hidden="true">&gt;</span>
      </button>`;
    }).join('') || '<div class="video-list-empty">No UAVs are configured.</div>';

    list.querySelectorAll('[data-video-uav]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedUavId = button.dataset.videoUav;
        activeStreamKey = '';
        failedStreamKey = '';
        lastListSignature = '';
        renderVideoView(vehicles);
      });
    });
  }

  const selected = vehicles.find((vehicle) => vehicle.uav_id === selectedUavId);
  if (!selected) {
    title.textContent = 'Select a UAV';
    subtitle.textContent = 'Live camera stream';
    badge.textContent = 'No UAV selected';
    badge.dataset.state = 'offline';
    emptyTitle.textContent = 'Choose a UAV to begin';
    emptyMessage.textContent = 'The selected camera feed will appear here.';
    stopStreams(image, video);
    emptyState.hidden = false;
    return;
  }

  title.textContent = selected.uav_id;
  subtitle.textContent = selected.autopilot ? `${selected.autopilot} · ${selected.flight_mode ?? 'Mode unavailable'}` : 'Live camera stream';
  badge.textContent = selected.connected ? 'UAV connected' : 'UAV offline';
  badge.dataset.state = selected.connected ? 'connected' : 'offline';

  if (!selected.connected) {
    emptyTitle.textContent = 'UAV is offline';
    emptyMessage.textContent = 'The camera stream is available when the UAV reconnects.';
    stopStreams(image, video);
    emptyState.hidden = false;
    return;
  }

  if (!selected.camera_url) {
    emptyTitle.textContent = 'Camera URL is not configured';
    emptyMessage.textContent = `Set ${selected.uav_id.toUpperCase()}_CAMERA_URL in the backend environment, then restart the backend.`;
    stopStreams(image, video);
    emptyState.hidden = false;
    return;
  }

  const streamUrl = safeStreamUrl(selected.camera_url);
  if (!streamUrl) {
    emptyTitle.textContent = 'Camera URL is invalid';
    emptyMessage.textContent = 'Use an HTTP or HTTPS stream URL reachable from this browser.';
    stopStreams(image, video);
    emptyState.hidden = false;
    return;
  }

  emptyState.hidden = true;
  streamLabel.textContent = 'LIVE CAMERA';
  const streamKey = `${selected.uav_id}:${streamUrl}`;
  if (streamKey === activeStreamKey) return;
  if (streamKey === failedStreamKey) {
    emptyTitle.textContent = 'Unable to load camera stream';
    emptyMessage.textContent = 'Check the camera URL, network access, and browser-compatible stream format.';
    emptyState.hidden = false;
    return;
  }
  stopStreams(image, video);
  activeStreamKey = streamKey;

  if (/\.(mp4|webm|ogv)(\?|$)/i.test(streamUrl)) {
    video.hidden = false;
    video.src = streamUrl;
    video.play().catch(() => {});
    video.onerror = () => showStreamError(emptyState, emptyTitle, emptyMessage, image, video);
  } else {
    image.hidden = false;
    image.src = streamUrl;
    image.onerror = () => showStreamError(emptyState, emptyTitle, emptyMessage, image, video);
  }
}

function showStreamError(emptyState, title, message, image, video) {
  failedStreamKey = activeStreamKey;
  stopStreams(image, video);
  title.textContent = 'Unable to load camera stream';
  message.textContent = 'Check the camera URL, network access, and browser-compatible stream format.';
  emptyState.hidden = false;
}

function stopStreams(image, video) {
  image.onerror = null;
  image.removeAttribute('src');
  image.hidden = true;
  video.onerror = null;
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  activeStreamKey = '';
}

function safeStreamUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}
