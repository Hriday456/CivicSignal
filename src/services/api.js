// ---------------------------------------------------------------------------
// DATA ACCESS LAYER - Talks directly to Supabase with instant local cache
// ---------------------------------------------------------------------------
import { supabase } from './supabase';
import { generateComplaints } from '../data/seed';
import { departmentFor } from '../data/taxonomy';
import { classify, findDuplicateCandidates } from '../utils/mockAI';
import { computePriority } from '../utils/priority';

const KEY = 'cs_complaints_v2';

function readLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch { /* empty */ }
  const seed = generateComplaints();
  try { localStorage.setItem(KEY, JSON.stringify(seed)); } catch { /* ignore */ }
  return seed;
}

function writeLocal(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); }
  catch (e) { console.warn('Local cache write failed', e); }
}

// Attach computed fields (priority score + breakdown, group size) to every complaint.
function withDerived(list) {
  const now = Date.now();
  const groupSizes = {};
  list.forEach((c) => {
    const g = c.aiPredictions?.duplicateGroupId;
    if (g) groupSizes[g] = (groupSizes[g] || 0) + 1;
  });
  const subOf = (c) => c.adminState?.confirmed?.subcategory || c.aiPredictions?.subcategory;
  
  return list.map((c) => {
    const t = new Date(c.citizenInput?.createdAt || Date.now()).getTime();
    const recurrenceCount = list.filter((o) =>
      o.id !== c.id &&
      o.citizenInput?.location?.area === c.citizenInput?.location?.area &&
      subOf(o) === subOf(c) &&
      new Date(o.citizenInput?.createdAt || 0).getTime() < t &&
      t - new Date(o.citizenInput?.createdAt || 0).getTime() < 90 * 86400000
    ).length;
    const groupSize = groupSizes[c.aiPredictions?.duplicateGroupId] || 1;
    const priority = computePriority(c, { groupSize, recurrenceCount }, now);
    return { ...c, derived: { priority, groupSize, recurrenceCount } };
  });
}

// ----------------------------- READS ---------------------------------------
export async function listComplaints() {
  try {
    // 1. Try reading from Supabase
    // Never wait more than 4 seconds for Supabase, otherwise the page spins forever
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase timed out')), 4000));
    const { data: remoteData, error } = await Promise.race([
      supabase
        .from('complaints')
        .select('*, ai_predictions(*), admin_state(*)')
        .order('created_at', { ascending: false }),
      timeout,
    ]);

    if (!error && remoteData && remoteData.length > 0) {
      // Format Supabase rows back to the frontend shape
      const formatted = remoteData.map((row) => {
        const ai = Array.isArray(row.ai_predictions) ? row.ai_predictions[0] : row.ai_predictions;
        const adm = Array.isArray(row.admin_state) ? row.admin_state[0] : row.admin_state;
        return {
          id: row.id,
          citizenInput: {
            submittedBy: row.submitted_by || 'guest',
            submitterName: row.submitter_name || 'Guest citizen',
            title: row.title,
            description: row.description,
            location: {
              lat: row.lat,
              lng: row.lng,
              address: row.address,
              area: row.area,
              zone: row.zone,
            },
            photoUrl: row.photo_url,
            citizenCategory: row.citizen_category,
            citizenSeverity: row.citizen_severity,
            createdAt: row.created_at,
          },
          aiPredictions: ai ? {
            category: ai.category,
            subcategory: ai.subcategory,
            severity: ai.severity,
            confidence: ai.confidence_json || { category: 0.8, subcategory: 0.8, severity: 0.8 },
            confidenceScore: ai.confidence_score || 80,
            needsHumanReview: ai.needs_human_review,
            reviewReason: ai.review_reason,
            duplicateGroupId: ai.duplicate_group_id,
            duplicateCandidates: ai.duplicate_candidates || [],
            cues: ai.cues || [],
            summary: `${ai.subcategory || ''} reported at ${row.address || row.area}.`,
            modelVersion: ai.model_version || 'prototype-mock-v0',
          } : {},
          adminState: adm ? {
            status: adm.status || 'Pending',
            reviewState: adm.review_state || 'Pending Review',
            confirmed: adm.confirmed_category ? {
              category: adm.confirmed_category,
              subcategory: adm.confirmed_subcategory,
              severity: adm.confirmed_severity,
            } : null,
            suggestedDepartment: adm.suggested_department,
            assignedDepartment: adm.assigned_department,
            notes: adm.notes || [],
            resolvedAt: adm.resolved_at,
            history: adm.history || [],
          } : { status: 'Pending', reviewState: 'Pending Review', history: [], notes: [] },
        };
      });

      writeLocal(formatted);
      return withDerived(formatted);
    }
  } catch (err) {
    console.warn('Supabase fetch failed, using local cache:', err.message);
  }

  // Fallback to local cache
  return withDerived(readLocal());
}

export async function getComplaint(id) {
  const key = String(id || '').trim().toUpperCase();
  const all = await listComplaints();
  return all.find((c) => c.id.toUpperCase() === key) || null;
}

// ----------------------------- WRITES --------------------------------------
function mutate(id, fn) {
  const list = readLocal();
  const idx = list.findIndex((c) => c.id === id);
  if (idx !== -1) {
    list[idx] = fn(structuredClone(list[idx]));
    writeLocal(list);
    return list[idx];
  }
  return null;
}

// Saves changes to the admin_state row. Uses await + try/catch (Supabase queries have no .catch).
async function syncAdminState(id, patch) {
  try {
    const { error } = await supabase.from('admin_state').update(patch).eq('complaint_id', id);
    if (error) console.warn('Supabase update failed:', error.message);
  } catch (err) {
    console.warn('Supabase update failed:', err.message);
  }
}

const stamp = (status, by, note) => ({ status, at: new Date().toISOString(), by, note });

export async function createComplaint({ title, description, location, photoUrl, citizenCategory, citizenSeverity, user }) {
  const list = readLocal();
  const maxNo = list.reduce((m, c) => Math.max(m, parseInt(c.id?.split('-')[2], 10) || 0), 1000);
  const id = `CS-2026-${maxNo + 1}`;
  
  const ai = classify(title, description);
  const dupes = findDuplicateCandidates(list, { subcategory: ai.subcategory, lat: location.lat, lng: location.lng });
  const groupId = dupes[0]?.groupId || null;

  const complaint = {
    id,
    citizenInput: {
      submittedBy: user?.id || 'guest',
      submitterName: user?.name || 'Guest citizen',
      title, description, location, photoUrl: photoUrl || null,
      citizenCategory: citizenCategory || null,
      citizenSeverity: citizenSeverity || null,
      createdAt: new Date().toISOString(),
    },
    aiPredictions: {
      category: ai.category, subcategory: ai.subcategory, severity: ai.severity,
      confidence: ai.confidence, confidenceScore: ai.confidenceScore,
      needsHumanReview: ai.needsHumanReview, reviewReason: ai.reviewReason,
      duplicateGroupId: groupId, duplicateCandidates: dupes.map((d) => d.id),
      cues: ai.cues, summary: `${ai.subcategory} reported at ${location.address}.`,
      modelVersion: ai.modelVersion,
    },
    adminState: {
      status: 'Pending',
      reviewState: ai.unable ? 'Unable to Classify' : 'Pending Review',
      confirmed: null,
      suggestedDepartment: ai.suggestedDepartment,
      assignedDepartment: null, notes: [], resolvedAt: null,
      history: [stamp('Pending', 'System', 'Complaint received and analysed by AI')],
    },
  };

  // 1. Save locally for instant UI responsiveness
  writeLocal([complaint, ...list]);

  // 2. Insert into Supabase in the background
  try {
    await supabase.from('complaints').insert({
      id,
      title,
      description,
      citizen_category: citizenCategory || null,
      citizen_severity: citizenSeverity || null,
      lat: location.lat,
      lng: location.lng,
      address: location.address || '',
      area: location.area || '',
      zone: location.zone || '',
      photo_url: photoUrl || null,
      submitter_name: user?.name || 'Guest citizen',
    });

    await supabase.from('ai_predictions').insert({
      complaint_id: id,
      category: ai.category,
      subcategory: ai.subcategory,
      severity: ai.severity,
      confidence_json: ai.confidence,
      confidence_score: ai.confidenceScore,
      needs_human_review: ai.needsHumanReview,
      review_reason: ai.reviewReason,
      suggested_department: ai.suggestedDepartment,
      duplicate_group_id: groupId,
      duplicate_candidates: dupes.map((d) => d.id),
      cues: ai.cues,
      model_version: ai.modelVersion,
    });

    await supabase.from('admin_state').insert({
      complaint_id: id,
      status: 'Pending',
      review_state: ai.unable ? 'Unable to Classify' : 'Pending Review',
      suggested_department: ai.suggestedDepartment,
      notes: [],
      history: [stamp('Pending', 'System', 'Complaint received and analysed by AI')],
    });
  } catch (err) {
    console.warn('Supabase remote insert error:', err.message);
  }

  return complaint;
}

export async function confirmClassification(id, { category, subcategory, severity }, by) {
  const updated = mutate(id, (c) => {
    const ai = c.aiPredictions;
    const changed = ai.category !== category || ai.subcategory !== subcategory || ai.severity !== severity;
    c.adminState.confirmed = { category, subcategory, severity };
    c.adminState.reviewState = changed ? 'Corrected' : 'Confirmed';
    c.adminState.suggestedDepartment = departmentFor(category);
    c.adminState.history.push(stamp(c.adminState.status, by, changed ? 'Classification corrected by reviewer' : 'AI classification confirmed by reviewer'));
    return c;
  });

  await syncAdminState(id, {
    confirmed_category: category,
    confirmed_subcategory: subcategory,
    confirmed_severity: severity,
    review_state: updated?.adminState?.reviewState,
    suggested_department: departmentFor(category),
    history: updated?.adminState?.history,
  });

  return updated;
}

export async function assignDepartment(id, department, by) {
  const updated = mutate(id, (c) => {
    c.adminState.assignedDepartment = department;
    if (c.adminState.status === 'Pending') c.adminState.status = 'Assigned';
    c.adminState.history.push(stamp(c.adminState.status, by, `Assigned to ${department}`));
    return c;
  });

  await syncAdminState(id, {
    assigned_department: department,
    status: updated?.adminState?.status,
    history: updated?.adminState?.history,
  });

  return updated;
}

export async function setStatus(id, status, by, note) {
  const updated = mutate(id, (c) => {
    c.adminState.status = status;
    c.adminState.resolvedAt = status === 'Resolved' ? new Date().toISOString() : null;
    c.adminState.history.push(stamp(status, by, note || `Status changed to ${status}`));
    return c;
  });

  await syncAdminState(id, {
    status,
    resolved_at: status === 'Resolved' ? new Date().toISOString() : null,
    history: updated?.adminState?.history,
  });

  return updated;
}

export async function addNote(id, text, by) {
  const updated = mutate(id, (c) => {
    c.adminState.notes.push({ text, by, at: new Date().toISOString() });
    return c;
  });

  await syncAdminState(id, {
    notes: updated?.adminState?.notes,
  });

  return updated;
}

export async function mergeDuplicate(id, otherId) {
  const list = readLocal();
  const a = list.find((c) => c.id === id);
  const b = list.find((c) => c.id === otherId);
  if (!a || !b) return;
  const gid = a.aiPredictions.duplicateGroupId || b.aiPredictions.duplicateGroupId
    || `DG-${String(Math.floor(Math.random() * 900) + 100)}`;
  a.aiPredictions.duplicateGroupId = gid;
  b.aiPredictions.duplicateGroupId = gid;
  [a, b].forEach((c) => {
    const o = c === a ? b : a;
    if (!c.aiPredictions.duplicateCandidates.includes(o.id)) c.aiPredictions.duplicateCandidates.push(o.id);
  });
  writeLocal(list);
}

export async function dismissDuplicate(id, otherId) {
  return mutate(id, (c) => {
    c.aiPredictions.duplicateCandidates = c.aiPredictions.duplicateCandidates.filter((x) => x !== otherId);
    return c;
  });
}

export function resetDemoData() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}