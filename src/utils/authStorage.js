import { supabase } from '../services/supabase';

const USERS = 'users';
const ACTIVE = 'activeUser';

// The demo accounts are ALWAYS kept in the user list (added back if missing).
const DEMO_USERS = [
  { id: 'usr_default1', name: 'Ravi Kumar', email: 'citizen@civic.com', password: 'password', role: 'citizen', civicScore: 120 },
  { id: 'adm_default1', name: 'Priya Sharma', email: 'admin@civic.com', password: 'password', role: 'admin', department: 'Central Dispatch' },
];

export const initializeStorage = () => {
  let users = [];
  try { users = JSON.parse(localStorage.getItem(USERS) || '[]'); } catch { users = []; }
  let changed = false;
  DEMO_USERS.forEach((demo) => {
    if (!users.some((u) => u.email === demo.email)) { users.push(demo); changed = true; }
  });
  if (changed || !localStorage.getItem(USERS)) localStorage.setItem(USERS, JSON.stringify(users));
};

export const registerUser = (userData) => {
  initializeStorage();

  const users = JSON.parse(localStorage.getItem(USERS) || '[]');
  if (users.find((u) => u.email === userData.email)) {
    throw new Error('User with this email already exists.');
  }

  // Self-registration is ALWAYS a citizen. Admin accounts are created by the municipality only.
  const newUser = {
    id: `usr_${Math.random().toString(36).slice(2, 11)}`,
    name: userData.name,
    email: userData.email,
    password: userData.password,
    role: 'citizen',
    civicScore: 10,
  };

  users.push(newUser);
  localStorage.setItem(USERS, JSON.stringify(users));

  // Also register with Supabase in the background
  supabase.auth.signUp({
    email: userData.email,
    password: userData.password,
    options: {
      data: { name: userData.name },
    },
  }).catch((err) => {
    console.warn('Supabase signup background note:', err.message);
  });

  return newUser;
};

export const loginUser = (email, password) => {
  initializeStorage();

  // Trigger Supabase sign-in asynchronously in the background
  supabase.auth.signInWithPassword({ email, password }).catch((err) => {
    console.warn('Supabase auth note:', err.message);
  });

  const users = JSON.parse(localStorage.getItem(USERS) || '[]');
  const user = users.find((u) => u.email === email && u.password === password);
  if (!user) throw new Error('Invalid email or password.');

  localStorage.setItem(ACTIVE, JSON.stringify(user));
  window.dispatchEvent(new Event('cs-auth'));
  return user;
};

export const getActiveUser = () => {
  try {
    const user = localStorage.getItem(ACTIVE);
    return user ? JSON.parse(user) : null;
  } catch { return null; }
};

export const logoutUser = () => {
  supabase.auth.signOut().catch(() => {});
  localStorage.removeItem(ACTIVE);
  window.dispatchEvent(new Event('cs-auth'));
};

export const addCivicPoints = (points) => {
  const active = getActiveUser();
  if (!active || active.role !== 'citizen') return null;
  const users = JSON.parse(localStorage.getItem(USERS) || '[]');
  const idx = users.findIndex((u) => u.id === active.id);
  const updated = { ...active, civicScore: (active.civicScore || 0) + points };
  if (idx >= 0) { 
    users[idx] = { ...users[idx], civicScore: updated.civicScore }; 
    localStorage.setItem(USERS, JSON.stringify(users)); 
  }
  localStorage.setItem(ACTIVE, JSON.stringify(updated));
  window.dispatchEvent(new Event('cs-auth'));
  return updated;
};