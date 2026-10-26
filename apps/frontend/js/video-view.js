import { onStateUpdate } from './state.js?v=20261015-7';

let selectedUavId = null;
let activeStreamKey = '';
let lastListSignature = '';
let failedStreamKey = '';
let streamGeneration = 0;
let peerConnection = null;
let whepSessionUrl = null;
let reconnectTimer = null;
let watchdogTimer = null;
let reconnectAttempts = 0;
let lastVideoTime = 0;
let lastFrameProgressAt = 0;

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
      const status = vehicle.camera_url
        ? (vehicle.connected ? 'Camera ready' : 'Camera ready (UAV offline)')
        : (vehicle.connected ? 'No camera URL' : 'Offline (no camera URL)');
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
  badge.textContent = selected.connected ? 'UAV connected' : 'UAV offline · camera can still stream';
  badge.dataset.state = selected.connected ? 'connected' : 'offline';
  badge.dataset.uavConnected = String(selected.connected);

  if (!selected.camera_url) {
    emptyTitle.textContent = 'Camera URL is not configured';
    emptyMessage.textContent = `Configure the ${selected.uav_id.toUpperCase()} camera in the backend config file, then restart the backend.`;
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
  failedStreamKey = '';
  streamLabel.textContent = 'LIVE CAMERA';

  if (isMediaMtxPlayer(streamUrl)) {
    emptyTitle.textContent = 'Connecting to camera';
    emptyMessage.textContent = 'The video will start automatically. The connection retries if the stream drops.';
    emptyState.hidden = false;
    reconnectAttempts = 0;
    connectWhep(mediaMtxWhepUrl(streamUrl), video, badge, emptyState, streamKey, streamGeneration);
  } else if (/\.(mp4|webm|ogv)(\?|$)/i.test(streamUrl)) {
    emptyState.hidden = true;
    video.hidden = false;
    video.controls = true;
    video.src = streamUrl;
    video.play().catch(() => {});
    video.onerror = () => showStreamError(emptyState, emptyTitle, emptyMessage, image, video);
  } else {
    emptyState.hidden = true;
    image.hidden = false;
    image.src = streamUrl;
    image.onerror = () => showStreamError(emptyState, emptyTitle, emptyMessage, image, video);
  }
}

async function connectWhep(endpoint, video, badge, emptyState, streamKey, generation) {
  if (generation !== streamGeneration || activeStreamKey !== streamKey) return;
  if (watchdogTimer) window.clearInterval(watchdogTimer);
  watchdogTimer = null;
  const connection = new RTCPeerConnection();
  peerConnection = connection;
  const remoteStream = new MediaStream();
  video.hidden = false;
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.controls = false;
  video.srcObject = remoteStream;
  lastVideoTime = 0;
  lastFrameProgressAt = Date.now();

  connection.addTransceiver('video', { direction: 'recvonly' });
  connection.ontrack = (event) => {
    if (generation !== streamGeneration || activeStreamKey !== streamKey || peerConnection !== connection) return;
    const stream = event.streams?.[0];
    if (stream) {
      video.srcObject = stream;
    } else if (!remoteStream.getTracks().some((track) => track.id === event.track.id)) {
      remoteStream.addTrack(event.track);
    }
    emptyState.hidden = true;
    video.play().catch(() => {});
  };
  connection.onconnectionstatechange = () => {
    if (generation !== streamGeneration || activeStreamKey !== streamKey || peerConnection !== connection) return;
    if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
      queueReconnect(endpoint, video, badge, emptyState, streamKey, generation);
    } else if (connection.connectionState === 'disconnected') {
      queueReconnect(endpoint, video, badge, emptyState, streamKey, generation, 4000);
    }
  };

  watchdogTimer = window.setInterval(() => {
    if (generation !== streamGeneration || activeStreamKey !== streamKey || peerConnection !== connection) return;
    const now = Date.now();
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime > lastVideoTime + 0.05) {
      lastVideoTime = video.currentTime;
      lastFrameProgressAt = now;
      reconnectAttempts = 0;
      badge.textContent = 'Camera live' + (badge.dataset.uavConnected === 'true' ? ' · UAV connected' : ' · UAV offline');
      return;
    }
    if (now - lastFrameProgressAt > 8000) {
      queueReconnect(endpoint, video, badge, emptyState, streamKey, generation);
    }
  }, 3000);

  try {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection, 6000);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
      body: connection.localDescription.sdp,
    });
    if (!response.ok) throw new Error(`WebRTC handshake failed (${response.status})`);
    const location = response.headers.get('Location');
    const sessionUrl = location ? new URL(location, endpoint).href : null;
    const answer = await response.text();
    if (generation !== streamGeneration || activeStreamKey !== streamKey || peerConnection !== connection) {
      if (sessionUrl) fetch(sessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
      return;
    }
    whepSessionUrl = sessionUrl;
    await connection.setRemoteDescription({ type: 'answer', sdp: answer });
  } catch (error) {
    if (generation !== streamGeneration || activeStreamKey !== streamKey || peerConnection !== connection) return;
    console.warn(`[${streamKey}] WebRTC connection failed; retrying`, error);
    queueReconnect(endpoint, video, badge, emptyState, streamKey, generation);
  }
}

function queueReconnect(endpoint, video, badge, emptyState, streamKey, generation, delayOverride = null) {
  if (generation !== streamGeneration || activeStreamKey !== streamKey || reconnectTimer) return;
  const delay = delayOverride ?? Math.min(1000 * (2 ** reconnectAttempts), 10000);
  reconnectAttempts += 1;
  badge.textContent = 'Reconnecting camera';
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (generation !== streamGeneration || activeStreamKey !== streamKey) return;
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
      peerConnection = null;
    }
    releaseWhepSession();
    video.srcObject = null;
    lastFrameProgressAt = Date.now();
    if (watchdogTimer) window.clearInterval(watchdogTimer);
    watchdogTimer = null;
    connectWhep(endpoint, video, badge, emptyState, streamKey, generation);
  }, delay);
}

function waitForIceGathering(connection, timeoutMs) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      connection.removeEventListener('icegatheringstatechange', onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (connection.iceGatheringState === 'complete') finish();
    };
    const timeout = setTimeout(finish, timeoutMs);
    connection.addEventListener('icegatheringstatechange', onStateChange);
  });
}

function showStreamError(emptyState, title, message, image, video) {
  failedStreamKey = activeStreamKey;
  stopStreams(image, video);
  title.textContent = 'Unable to load camera stream';
  message.textContent = 'Check the camera URL, network access, and browser-compatible stream format.';
  emptyState.hidden = false;
}

function stopStreams(image, video) {
  streamGeneration += 1;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (watchdogTimer) window.clearInterval(watchdogTimer);
  watchdogTimer = null;
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
  releaseWhepSession();
  image.onerror = null;
  image.removeAttribute('src');
  image.hidden = true;
  video.onerror = null;
  video.pause();
  video.srcObject = null;
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  activeStreamKey = '';
}

function releaseWhepSession() {
  const sessionUrl = whepSessionUrl;
  whepSessionUrl = null;
  if (sessionUrl) fetch(sessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
}

function isMediaMtxPlayer(value) {
  try {
    const url = new URL(value);
    return url.port === '8889' && !url.pathname.endsWith('/whep');
  } catch {
    return false;
  }
}

function mediaMtxWhepUrl(value) {
  const url = new URL(value);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/whep`;
  url.search = '';
  url.hash = '';
  return url.href;
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
