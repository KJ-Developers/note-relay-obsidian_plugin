async function hashString(str) {
  const msgBuffer = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyAccess(password, email, settings) {
  // Hash the provided password
  const passwordHash = await hashString(password);
  
  // Check against master password
  if (settings.masterPasswordHash && passwordHash === settings.masterPasswordHash) {
    return true;
  }
  
  // Check against guest list
  if (email && settings.guestList && Array.isArray(settings.guestList)) {
    const guest = settings.guestList.find(g => g.email === email);
    if (guest && guest.passHash === passwordHash && guest.status === 'verified') {
      return true;
    }
  }
  
  return false;
}

module.exports = {
  hashString,
  verifyAccess
};
