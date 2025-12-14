const { createClient } = require('@supabase/supabase-js');
const SimplePeer = require('simple-peer');

// Supabase credentials (loaded from API)
let supabase = null;

async function initializeSignaling(supabaseUrl, supabaseAnonKey, signalId, iceServers, plugin) {
  try {
    supabase = createClient(supabaseUrl, supabaseAnonKey);
    console.log('[WebRTC] Supabase client created');
    
    // Subscribe to signaling channel
    const channel = supabase.channel('host-channel')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'signaling',
        filter: `target=eq.${signalId}`
      }, async (payload) => {
        console.log('[WebRTC] Incoming signal:', payload.new.type);
        
        if (payload.new.type === 'offer') {
          await handleIncomingOffer(payload.new.source, payload.new.payload, signalId, iceServers, plugin);
        }
      })
      .subscribe((status) => {
        console.log('[WebRTC] Channel status:', status);
      });
    
    console.log('[WebRTC] Signaling initialized, listening for offers');
    return channel;
  } catch (error) {
    console.error('[WebRTC] Failed to initialize signaling:', error);
    return null;
  }
}

async function handleIncomingOffer(remoteId, offerSignal, signalId, iceServers, plugin) {
  console.log('[WebRTC] Creating answering peer for:', remoteId);
  
  const peer = new SimplePeer({
    initiator: false,
    trickle: false,
    config: {
      iceServers: iceServers || [{ urls: 'stun:stun.l.google.com:19302' }]
    }
  });
  
  // Per-peer auth state
  const peerState = {
    isAuthenticated: false,
    isReadOnly: false,
    userIdentifier: 'unknown'
  };
  
  // Send callback for command responses
  const sendCallback = (type, data, meta = {}) => {
    try {
      const response = { type, ...data, ...meta };
      peer.send(JSON.stringify(response));
    } catch (error) {
      console.error('[WebRTC] Send error:', error);
    }
  };
  
  // Handle signal (send answer back)
  peer.on('signal', async (data) => {
    await supabase.from('signaling').insert({
      source: 'host',
      target: remoteId,
      type: 'answer',
      payload: data
    });
    console.log('[WebRTC] Answer sent to:', remoteId);
  });
  
  // Handle connection
  peer.on('connect', () => {
    console.log('[WebRTC] Peer connected:', remoteId);
    plugin.statusBar.setText('Portal: Verifying...');
  });
  
  // Handle data (commands)
  peer.on('data', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log('[WebRTC] Command received:', msg.cmd);
      
      // Route to command handler
      const commands = require('./commands');
      await commands.handleCommand(msg, plugin, sendCallback, peerState);
      
      // Update status bar after auth
      if (peerState.isAuthenticated && msg.cmd === 'PING') {
        plugin.statusBar.setText(`Linked: ${peerState.userIdentifier}${peerState.isReadOnly ? ' (RO)' : ''}`);
        plugin.statusBar.style.color = '#4caf50';
      }
    } catch (error) {
      console.error('[WebRTC] Data handler error:', error);
    }
  });
  
  // Handle close
  peer.on('close', () => {
    console.log('[WebRTC] Peer disconnected:', remoteId);
    plugin.statusBar.setText('Portal: Active');
    plugin.statusBar.style.color = '';
  });
  
  // Handle error
  peer.on('error', (err) => {
    console.error('[WebRTC] Peer error:', err);
    plugin.statusBar.setText('Portal: Error');
  });
  
  // Signal the offer to start connection
  peer.signal(offerSignal);
}

function createPeer(initiator, config) {
  return new SimplePeer({
    initiator,
    trickle: true,
    config: {
      iceServers: config.iceServers || [
        { urls: 'stun:stun.l.google.com:19302' }
      ]
    }
  });
}

async function registerPresence(vaultId, userId) {
  if (!supabase) {
    throw new Error('Signaling not initialized');
  }
  
  const channel = supabase.channel(`vault:${vaultId}`);
  
  await channel
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      console.log('[WebRTC] Presence sync:', Object.keys(state).length, 'peers');
    })
    .on('presence', { event: 'join' }, ({ key, newPresences }) => {
      console.log('[WebRTC] Peer joined:', key);
    })
    .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
      console.log('[WebRTC] Peer left:', key);
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({
          userId,
          role: 'host',
          online_at: new Date().toISOString()
        });
      }
    });
  
  return channel;
}

module.exports = {
  initializeSignaling,
  handleIncomingOffer,
  createPeer,
  registerPresence
};
