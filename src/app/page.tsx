'use strict';

'use client';

import React, { useState, useEffect, useRef } from 'react';

// Define TS Interfaces
interface Lot {
  lot_id: string;
  quality: string;
  design: string;
  grade: string;
  status: string;
  balance: number;
}

interface LedgerEntry {
  id: number;
  lot_id: string;
  direction: 'IN' | 'OUT';
  meters: number;
  party: string;
  source_doc_id: string;
  ts: string;
  quality?: string;
  design?: string;
}

interface JobCard {
  id: number;
  lot_id: string;
  process: string;
  worker_id: string;
  worker_name: string;
  worker_section: string;
  meters_in: number;
  meters_out: number | null;
  shortage: number | null;
  shortage_pct: number;
  status: 'open' | 'in-process' | 'folded' | 'closed';
  ts_created: string;
  ts_closed: string | null;
  quality: string;
  design: string;
  flagged: boolean;
}

interface Allotment {
  id: number;
  worker_id: string;
  worker_name: string;
  job_card_id: number;
  meters_allotted: number;
  shift: string;
  date: string;
  process: string;
  lot_id: string;
}

interface Worker {
  id: string;
  name: string;
  section: string;
  role: string;
}

interface EfficiencyRecord {
  id: number;
  worker_id: string;
  name: string;
  section: string;
  date: string;
  allotted: number;
  done: number;
  efficiency_pct: number;
  flagged: boolean;
}

interface CaptureEvent {
  id: number;
  photo_url: string;
  type: 'incoming_stock' | 'outgoing_stock' | 'job_card_folding';
  ai_json: any;
  confidence: number;
  status: 'pending' | 'confirmed' | 'corrected' | 'rejected';
  confirmed_by: string | null;
  confirmed_by_name: string | null;
  ts: string;
}

interface ToastMessage {
  text: string;
  type: 'success' | 'danger' | 'warning';
}

// SVG Icon Components for a professional layout
interface IconProps {
  className?: string;
  size?: number;
  style?: React.CSSProperties;
}

const IconDashboard = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
);
const IconBox = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
);
const IconFileText = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
);
const IconSearch = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
);
const IconBrain = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1 0-3.12 3 3 0 0 1 0-4.88 2.5 2.5 0 0 1 0-3.12A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 0-3.12 3 3 0 0 0 0-4.88 2.5 2.5 0 0 0 0-3.12A2.5 2.5 0 0 0 14.5 2z"/></svg>
);
const IconUser = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
);
const IconRuler = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.3 8.7L8.7 21.3c-.8.8-2 .8-2.8 0L2.7 18c-.8-.8-.8-2 0-2.8L15.3 2.7c.8-.8 2-.8 2.8 0l3.2 3.2c.8.8.8 2 0 2.8z"/><path d="M6 18l1.5-1.5"/><path d="M8.5 15.5L10 14"/><path d="M11 13l1.5-1.5"/><path d="M13.5 10.5L15 9"/><path d="M16 8l1.5-1.5"/></svg>
);
const IconTag = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
);
const IconAlertTriangle = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
);
const IconCamera = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
);
const IconTv = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/></svg>
);
const IconSave = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
);
const IconTrash2 = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
);
const IconEdit = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
);
const IconSend = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
);
const IconCheck = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
);
const IconActivity = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
);
const IconPlus = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
);
const IconArrowRight = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
);
const IconClose = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
);
const IconInfo = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
);

// New SVG icons for complete emoji replacement
const IconZap = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
);
const IconRocket = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 16.5c-1.5 1.25-2.5 3.5-2.5 3.5s2.25-1 3.5-2.5L18.5 4.5c1.5-1.5 1-3.5 1-3.5s-2-.5-3.5 1L4.5 16.5z"/><path d="M12 12l9 9"/><path d="M9 15l-3 3"/><path d="M15 9l3-3"/></svg>
);
const IconBarChart = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
);
const IconClipboard = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
);
const IconFlag = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
);
const IconCalendar = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
);
const IconFile = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
);
const IconSettings = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
);
const IconArrowDown = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
);
const IconArrowUp = ({ className = "", size = 16, style }: IconProps) => (
  <svg className={className} style={style} xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
);

export default function TextileOpsPlatform() {
  // Navigation & Role states
  const [activeTab, setActiveTab] = useState<'dashboard' | 'stock' | 'jobcards' | 'confirmqueue' | 'chat'>('dashboard');
  const [userRole, setUserRole] = useState<'owner' | 'supervisor' | 'worker'>('owner');
  const [language, setLanguage] = useState<'en' | 'hi' | 'gu'>('en');

  // Data states
  const [lots, setLots] = useState<Lot[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [jobCards, setJobCards] = useState<JobCard[]>([]);
  const [allotments, setAllotments] = useState<Allotment[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [efficiency, setEfficiency] = useState<EfficiencyRecord[]>([]);
  const [captureEvents, setCaptureEvents] = useState<CaptureEvent[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [dbStatus, setDbStatus] = useState<{ status: string; dbTime?: string } | null>(null);

  // Toast notifications state
  const [toast, setToast] = useState<ToastMessage | null>(null);

  // Form states
  const [stockForm, setStockForm] = useState({
    lot_id: '',
    direction: 'IN',
    meters: '',
    party: '',
    source_doc: '',
    quality: '',
    design: ''
  });

  const [jobCardForm, setJobCardForm] = useState({
    lot_id: '',
    process: 'Weaving',
    worker_id: '',
    meters_in: '',
    shift: 'Morning'
  });

  // Capture upload state
  const [uploadType, setUploadType] = useState<'incoming_stock' | 'outgoing_stock' | 'job_card_folding'>('incoming_stock');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Correction queue state
  const [correctingEventId, setCorrectingEventId] = useState<number | null>(null);
  const [correctedData, setCorrectedData] = useState<any>({});

  // Direct manual complete folding state
  const [completingJobCardId, setCompletingJobCardId] = useState<number | null>(null);
  const [metersOutInput, setMetersOutInput] = useState<string>('');

  // Chat states
  const [chatInput, setChatInput] = useState<string>('');
  const [messages, setMessages] = useState<Array<{
    sender: 'user' | 'bot';
    text: string;
    sql?: string;
    rows?: any[];
    timestamp: Date;
    loading?: boolean;
    error?: boolean;
  }>>([
    {
      sender: 'bot',
      text: 'Hello! I am the Textile Brain. Ask me any natural-language question about fabric lots, stock balances, ledger movements, job cards, or worker efficiency, and I will query the central database for you.',
      timestamp: new Date()
    }
  ]);
  const [activeSqlId, setActiveSqlId] = useState<number | null>(null);

  // Fetch all data
  const fetchData = async () => {
    try {
      setLoading(true);
      
      // Check database status
      const dbCheckRes = await fetch('/api/db-check');
      const dbCheck = await dbCheckRes.json();
      setDbStatus(dbCheck);

      // Fetch stock
      const stockRes = await fetch('/api/stock');
      const stockData = await stockRes.json();
      setLots(stockData.lots || []);
      setLedger(stockData.ledger || []);

      // Fetch job cards
      const jcRes = await fetch('/api/job-cards');
      const jcData = await jcRes.json();
      setJobCards(jcData.jobCards || []);
      setAllotments(jcData.allotments || []);

      // Fetch workers
      const workersRes = await fetch('/api/workers');
      const workersData = await workersRes.json();
      setWorkers(workersData.workers || []);
      setEfficiency(workersData.efficiency || []);

      // Fetch capture events
      const captureRes = await fetch('/api/capture');
      const captureData = await captureRes.json();
      setCaptureEvents(captureData.events || []);

    } catch (err) {
      console.error('Error loading data:', err);
      showToast('Error loading data from server. Ensure Postgres is running.', 'danger');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Show status Toast helper
  const showToast = (text: string, type: 'success' | 'danger' | 'warning' = 'success') => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Switch role-based access control
  const handleRoleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const role = e.target.value as 'owner' | 'supervisor' | 'worker';
    setUserRole(role);
    if (role === 'worker') {
      setActiveTab('stock'); // Workers default directly to stock/capture view
    } else {
      setActiveTab('dashboard');
    }
  };

  // Stock submit handler (Manual Entry)
  const handleStockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stockForm.lot_id || !stockForm.meters) {
      showToast('Please fill out lot number and meters.', 'warning');
      return;
    }

    try {
      const response = await fetch('/api/stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stockForm)
      });
      const resData = await response.json();

      if (!response.ok) {
        showToast(resData.error || 'Failed to submit stock entry.', 'danger');
        return;
      }

      showToast(`Stock ${stockForm.direction} entry for Lot ${stockForm.lot_id} recorded successfully!`, 'success');
      setStockForm({
        lot_id: '',
        direction: 'IN',
        meters: '',
        party: '',
        source_doc: '',
        quality: '',
        design: ''
      });
      fetchData();
    } catch (err) {
      showToast('Error sending request.', 'danger');
    }
  };

  // Job Card submit handler
  const handleJobCardSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!jobCardForm.lot_id || !jobCardForm.worker_id || !jobCardForm.meters_in) {
      showToast('Please fill out lot number, worker, and meters in.', 'warning');
      return;
    }

    try {
      const response = await fetch('/api/job-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jobCardForm)
      });
      const resData = await response.json();

      if (!response.ok) {
        showToast(resData.error || 'Failed to create job card.', 'danger');
        return;
      }

      showToast(`Job Card for Lot ${jobCardForm.lot_id} created successfully!`, 'success');
      setJobCardForm({
        lot_id: '',
        process: 'Weaving',
        worker_id: '',
        meters_in: '',
        shift: 'Morning'
      });
      fetchData();
    } catch (err) {
      showToast('Error sending request.', 'danger');
    }
  };

  // Manual Complete Folding handler
  const handleManualCompleteFolding = async (jobCardId: number) => {
    if (!metersOutInput) {
      showToast('Please enter folding meters out.', 'warning');
      return;
    }

    try {
      const response = await fetch('/api/job-cards', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: jobCardId,
          meters_out: metersOutInput
        })
      });
      const resData = await response.json();

      if (!response.ok) {
        showToast(resData.error || 'Failed to update job card.', 'danger');
        return;
      }

      showToast(`Job card ${jobCardId} completed. Shortage calculated: ${resData.jobCard.shortage}m (${resData.jobCard.shortage_pct}%)`, 'success');
      setCompletingJobCardId(null);
      setMetersOutInput('');
      fetchData();
    } catch (err) {
      showToast('Error completing job card.', 'danger');
    }
  };

  // Capture Image handler (triggers camera or file upload)
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
    }
  };

  // Upload photo capture event to API
  const handlePhotoUpload = async () => {
    if (!selectedFile) {
      showToast('Please choose or take a photo first.', 'warning');
      return;
    }

    try {
      setIsCapturing(true);
      const fd = new FormData();
      fd.append('file', selectedFile);
      fd.append('type', uploadType);

      const response = await fetch('/api/capture', {
        method: 'POST',
        body: fd
      });
      const resData = await response.json();

      if (!response.ok) {
        showToast(resData.error || 'Vision capture failed.', 'danger');
        return;
      }

      const { event, autoCommitted, commitError } = resData;

      if (autoCommitted) {
        showToast(`AI extraction highly confident (${Math.round(event.confidence * 100)}%). Auto-committed to database!`, 'success');
      } else {
        showToast(`AI extracted details but confidence is low (${Math.round(event.confidence * 100)}%). Held in Confirm Queue for supervisor review.`, 'warning');
        if (commitError) console.warn('Auto-commit warning:', commitError);
      }

      // Reset file upload state
      setSelectedFile(null);
      setPreviewUrl(null);
      fetchData();
    } catch (err) {
      showToast('Network error during upload.', 'danger');
    } finally {
      setIsCapturing(false);
    }
  };

  // Confirm/Edit Low-Confidence event handler
  const handleConfirmEvent = async (event: CaptureEvent, isCorrected: boolean) => {
    const payload = {
      event_id: event.id,
      confirmed_by: userRole === 'owner' ? 'usr-owner' : 'usr-sup1',
      status: isCorrected ? 'corrected' : 'confirmed',
      corrected_data: isCorrected ? correctedData : event.ai_json
    };

    try {
      const response = await fetch('/api/capture/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const resData = await response.json();

      if (!response.ok) {
        showToast(resData.error || 'Failed to confirm event.', 'danger');
        return;
      }

      showToast('Capture event approved and committed to ledger!', 'success');
      setCorrectingEventId(null);
      setCorrectedData({});
      fetchData();
    } catch (err) {
      showToast('Error confirming event.', 'danger');
    }
  };

  // Reject event handler
  const handleRejectEvent = async (eventId: number) => {
    try {
      const response = await fetch('/api/capture/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: eventId,
          confirmed_by: userRole === 'owner' ? 'usr-owner' : 'usr-sup1',
          status: 'rejected'
        })
      });

      if (!response.ok) {
        const err = await response.json();
        showToast(err.error || 'Failed to reject event.', 'danger');
        return;
      }

      showToast('Capture event rejected and removed from queue.', 'warning');
      setCorrectingEventId(null);
      fetchData();
    } catch (err) {
      showToast('Error rejecting event.', 'danger');
    }
  };

  // Start correcting mode
  const startCorrecting = (event: CaptureEvent) => {
    setCorrectingEventId(event.id);
    setCorrectedData({ ...event.ai_json });
  };

  // Handle changing inline fields for corrected data
  const handleCorrectionFieldChange = (key: string, val: any) => {
    setCorrectedData((prev: any) => ({
      ...prev,
      [key]: val
    }));
  };

  const handleChatSubmit = async (e?: React.FormEvent, customQuestion?: string) => {
    if (e) e.preventDefault();
    const question = customQuestion || chatInput;
    if (!question.trim()) return;

    const userMsg = { sender: 'user' as const, text: question, timestamp: new Date() };
    setMessages(prev => [...prev, userMsg]);
    if (!customQuestion) setChatInput('');

    const loadingMsg = { sender: 'bot' as const, text: 'Thinking...', timestamp: new Date(), loading: true };
    setMessages(prev => [...prev, loadingMsg]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, user_id: 'usr-owner' })
      });
      const resData = await response.json();

      setMessages(prev => {
        const filtered = prev.filter(m => !m.loading);
        if (!response.ok) {
          return [...filtered, {
            sender: 'bot',
            text: resData.error || 'Sorry, I encountered an error translating your query.',
            sql: resData.sql,
            timestamp: new Date(),
            error: true
          }];
        }
        return [...filtered, {
          sender: 'bot',
          text: resData.answer,
          sql: resData.sql,
          rows: resData.rows,
          timestamp: new Date()
        }];
      });
    } catch (err) {
      setMessages(prev => {
        const filtered = prev.filter(m => !m.loading);
        return [...filtered, {
          sender: 'bot',
          text: 'Network error. Please make sure the server is running.',
          timestamp: new Date(),
          error: true
        }];
      });
    }
  };

  // Localized dictionary for multi-language display
  const dictionary = {
    en: {
      dashboard: 'Dashboard',
      stock: 'Stock Inventory',
      jobcards: 'Job Cards',
      confirmQueue: 'Confirm Queue',
      incomingStock: 'Incoming Stock',
      outgoingStock: 'Outgoing Stock',
      foldingMeters: 'Folding Meters Out',
      allotments: 'Allotments',
      runningStock: 'Running Stock',
      efficiency: 'Worker Efficiency',
      shortage: 'Folding Shortage',
      upload: 'Upload photo & extract',
      confirm: 'Confirm',
      reject: 'Reject',
      correct: 'Correct',
      worker: 'Worker',
      supervisor: 'Supervisor',
      owner: 'Owner',
      lot: 'Lot #',
      meters: 'Meters',
      quality: 'Quality',
      design: 'Design',
      party: 'Party / Client',
      sourceDoc: 'Challan / Ref #',
      process: 'Process',
      status: 'Status',
      date: 'Date',
      allotted: 'Allotted',
      done: 'Done',
      action: 'Actions',
      noData: 'No records found'
    },
    hi: {
      dashboard: 'डैशबोर्ड',
      stock: 'स्टॉक इन्वेंटरी',
      jobcards: 'जॉब कार्ड्स',
      confirmQueue: 'सत्यापन कतार',
      incomingStock: 'आवक स्टॉक (IN)',
      outgoingStock: 'जावक स्टॉक (OUT)',
      foldingMeters: 'फोल्डिंग मीटर्स',
      allotments: 'काम आवंटन',
      runningStock: 'उपलब्ध स्टॉक',
      efficiency: 'कारीगर दक्षता',
      shortage: 'फोल्डिंग कमी',
      upload: 'फोटो अपलोड करें',
      confirm: 'स्वीकार करें',
      reject: 'अस्वीकार करें',
      correct: 'सुधारें',
      worker: 'कर्मचारी (Worker)',
      supervisor: 'सुपरवाइजर',
      owner: 'मालिक (Owner)',
      lot: 'लॉट नंबर',
      meters: 'मीटर्स',
      quality: 'क्वालिटी',
      design: 'डिज़ाइन',
      party: 'पार्टी नाम',
      sourceDoc: 'चालान नंबर',
      process: 'प्रक्रिया',
      status: 'स्थिति',
      date: 'तारीख',
      allotted: 'आवंटित',
      done: 'पूर्ण किया',
      action: 'कार्रवाई',
      noData: 'कोई रिकॉर्ड नहीं मिला'
    },
    gu: {
      dashboard: 'ડેશબોર્ડ',
      stock: 'સ્ટોક ઇન્વેન્ટરી',
      jobcards: 'જોબ કાર્ડ્સ',
      confirmQueue: 'પુષ્ટિ કતાર',
      incomingStock: 'આવક સ્ટોક (IN)',
      outgoingStock: 'જાવક સ્ટોક (OUT)',
      foldingMeters: 'ફોલ્ડિંગ મીટર',
      allotments: 'કામ ફાળવણી',
      runningStock: 'ઉપલબ્ધ સ્ટોક',
      efficiency: 'કારીગર કાર્યક્ષમતા',
      shortage: 'ફોલ્ડિંગ ઘટ',
      upload: 'ફોટો અપલોડ કરો',
      confirm: 'મંજૂર કરો',
      reject: 'નામંજૂર કરો',
      correct: 'સુધારો કરો',
      worker: 'કામદાર (Worker)',
      supervisor: 'સુપરવાઇઝર',
      owner: 'માલિક (Owner)',
      lot: 'લોટ નંબર',
      meters: 'મીટર',
      quality: 'ક્વોલિટી',
      design: 'ડિઝાઇન',
      party: 'પાર્ટીનું નામ',
      sourceDoc: 'ચલણ નંબર',
      process: 'પ્રક્રિયા',
      status: 'સ્થિતિ',
      date: 'તારીખ',
      allotted: 'ફાળવેલ',
      done: 'પૂર્ણ કરેલ',
      action: 'ક્રિયાઓ',
      noData: 'કોઈ રેકોર્ડ મળ્યો નથી'
    }
  };

  const t = dictionary[language];

  // Derive layout view
  const isWorkerMode = userRole === 'worker';

  // Compute stats
  const pendingCount = captureEvents.filter(e => e.status === 'pending').length;
  const totalLots = lots.length;
  const runningMeters = lots.reduce((acc, curr) => acc + curr.balance, 0);
  const shortageJobCards = jobCards.filter(jc => jc.flagged).length;

  return (
    <div className="app-container fade-in">
      {/* Toast Alert */}
      {toast && (
        <div className={`toast ${toast.type}`}>
          <span style={{ fontSize: '1.25rem' }}>
            {toast.type === 'success' ? '✓' : toast.type === 'danger' ? '✗' : 'i'}
          </span>
          <div>{toast.text}</div>
        </div>
      )}

      {/* Header */}
      <header className="app-header">
        <div className="logo-container">
          <div className="logo-icon">T</div>
          <div>
            <h1 className="logo-text">TEXTILE BRAIN</h1>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.1rem' }}>
              <span className="logo-badge">Surat Mill</span>
              <span style={{ fontSize: '0.7rem', color: varColors(dbStatus?.status).text }}>
                ● DB {dbStatus?.status === 'ok' ? 'Connected' : 'Offline'}
              </span>
            </div>
          </div>
        </div>

        {/* Global Controls */}
        <div className="user-profile">
          {/* Language Switcher */}
          <div style={{ display: 'flex', gap: '0.2rem', background: 'rgba(255,255,255,0.03)', padding: '0.2rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
            {(['en', 'hi', 'gu'] as const).map(lang => (
              <button
                key={lang}
                onClick={() => setLanguage(lang)}
                style={{
                  background: language === lang ? 'var(--primary)' : 'transparent',
                  border: 'none',
                  color: language === lang ? '#ffffff' : 'var(--text-secondary)',
                  padding: '0.25rem 0.5rem',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                {lang.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Role selector for simulation */}
          <select 
            value={userRole} 
            onChange={handleRoleChange} 
            className="role-selector"
          >
            <option value="owner">{t.owner}</option>
            <option value="supervisor">{t.supervisor}</option>
            <option value="worker">{t.worker} (Capture UI)</option>
          </select>
        </div>
      </header>

      {/* Tabs Menu (Hidden for worker role to enforce RBAC) */}
      {!isWorkerMode && (
        <div style={{ marginBottom: '2rem' }}>
          <div className="nav-tabs" style={{ display: 'inline-flex' }}>
            <button
              className={`nav-tab ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              <IconDashboard /> {t.dashboard}
            </button>
            <button
              className={`nav-tab ${activeTab === 'stock' ? 'active' : ''}`}
              onClick={() => setActiveTab('stock')}
            >
              <IconBox /> {t.stock}
            </button>
            <button
              className={`nav-tab ${activeTab === 'jobcards' ? 'active' : ''}`}
              onClick={() => setActiveTab('jobcards')}
            >
              <IconFileText /> {t.jobcards}
            </button>
            <button
              className={`nav-tab ${activeTab === 'confirmqueue' ? 'active' : ''}`}
              onClick={() => setActiveTab('confirmqueue')}
              style={{ position: 'relative' }}
            >
              <IconSearch /> {t.confirmQueue}
              {pendingCount > 0 && (
                <span style={{
                  background: 'var(--warning)',
                  color: 'black',
                  fontSize: '0.7rem',
                  padding: '0.05rem 0.35rem',
                  borderRadius: '10px',
                  fontWeight: 800,
                  marginLeft: '0.2rem'
                }}>
                  {pendingCount}
                </span>
              )}
            </button>
            <button
              className={`nav-tab ${activeTab === 'chat' ? 'active' : ''}`}
              onClick={() => setActiveTab('chat')}
            >
              <IconBrain /> AI Chat Brain
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '100px 0' }}>
          <div style={{
            width: '40px',
            height: '40px',
            border: '4px solid rgba(255,255,255,0.05)',
            borderTop: '4px solid var(--primary)',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }} />
          <p style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}>Connecting database and fetching records...</p>
          <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
        </div>
      ) : (
        <>
          {/* TAB: DASHBOARD */}
          {activeTab === 'dashboard' && !isWorkerMode && (
            <div className="fade-in">
              {/* Stats Grid */}
              <div className="dashboard-grid">
                <div className="card primary">
                  <div className="card-header">
                    <span className="card-title">Active Fabric Lots</span>
                    <div className="card-icon primary"><IconTag size={20} /></div>
                  </div>
                  <div className="card-value">{totalLots}</div>
                  <div className="card-desc">Registered in database</div>
                </div>

                <div className="card secondary">
                  <div className="card-header">
                    <span className="card-title">Total Running Stock</span>
                    <div className="card-icon secondary"><IconRuler size={20} /></div>
                  </div>
                  <div className="card-value">{runningMeters.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m</div>
                  <div className="card-desc">Sum of active IN ledger balances</div>
                </div>

                <div className="card danger">
                  <div className="card-header">
                    <span className="card-title">Shortage Alerts</span>
                    <div className="card-icon danger"><IconAlertTriangle size={20} /></div>
                  </div>
                  <div className="card-value">{shortageJobCards}</div>
                  <div className="card-desc">Shortages exceeding 3.0% limit</div>
                </div>

                <div className="card warning">
                  <div className="card-header">
                    <span className="card-title">Pending Confirms</span>
                    <div className="card-icon warning"><IconSearch size={20} /></div>
                  </div>
                  <div className="card-value">{pendingCount}</div>
                  <div className="card-desc">Low-confidence AI readings</div>
                </div>
              </div>

              {/* Central Dashboard Data Row */}
              <div className="content-layout">
                {/* Main: Stock Balances & Job Card Statuses */}
                <div className="main-column">
                  {/* Running Stock per Lot */}
                  <div className="card">
                    <h3 style={{ marginBottom: '1.25rem', fontFamily: 'var(--font-display)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <IconBox size={18} style={{ color: 'var(--primary)' }} />
                        Running Stock Balance per Lot
                      </span>
                      <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-muted)' }}>Derives from append-only movements ledger</span>
                    </h3>

                    {lots.length === 0 ? (
                      <div className="empty-state">
                        <div className="empty-state-icon" style={{ display: 'flex', justifyContent: 'center' }}><IconTag size={48} /></div>
                        <div className="empty-state-text">No fabric lots in database</div>
                      </div>
                    ) : (
                      <div className="table-container">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>{t.lot}</th>
                              <th>{t.quality}</th>
                              <th>{t.design}</th>
                              <th>Grade</th>
                              <th>Status</th>
                              <th style={{ textAlign: 'right' }}>{t.runningStock}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {lots.map(lot => (
                              <tr key={lot.lot_id}>
                                <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{lot.lot_id}</td>
                                <td>{lot.quality}</td>
                                <td>
                                  <span style={{ background: 'rgba(255,255,255,0.04)', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.8rem' }}>
                                    {lot.design}
                                  </span>
                                </td>
                                <td>{lot.grade}</td>
                                <td>
                                  <span className={`badge ${lot.status === 'active' ? 'success' : lot.status === 'hold' ? 'warning' : 'neutral'}`}>
                                    {lot.status}
                                  </span>
                                </td>
                                <td style={{ textAlign: 'right', fontWeight: 700, color: lot.balance > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                                  {lot.balance.toFixed(2)} m
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* Active Job Cards */}
                  <div className="card">
                    <h3 style={{ marginBottom: '1.25rem', fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <IconFileText size={18} style={{ color: 'var(--primary)' }} />
                      Active Job Cards
                    </h3>
                    {jobCards.length === 0 ? (
                      <div className="empty-state">
                        <div className="empty-state-icon" style={{ display: 'flex', justifyContent: 'center' }}><IconFileText size={48} /></div>
                        <div className="empty-state-text">No job cards in database</div>
                      </div>
                    ) : (
                      <div className="table-container">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>JC ID</th>
                              <th>{t.lot}</th>
                              <th>{t.process}</th>
                              <th>Assigned {t.worker}</th>
                              <th>Meters In</th>
                              <th>Meters Out</th>
                              <th>{t.shortage}</th>
                              <th>{t.status}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {jobCards.slice(0, 5).map(jc => (
                              <tr key={jc.id}>
                                <td style={{ color: 'var(--text-muted)' }}>#{jc.id}</td>
                                <td style={{ fontWeight: 600 }}>{jc.lot_id}</td>
                                <td>{jc.process}</td>
                                <td>{jc.worker_name}</td>
                                <td>{jc.meters_in.toFixed(2)} m</td>
                                <td>{jc.meters_out !== null ? `${jc.meters_out.toFixed(2)} m` : '--'}</td>
                                <td style={{ 
                                  color: jc.flagged ? 'var(--danger)' : jc.shortage !== null ? 'var(--text-secondary)' : 'var(--text-muted)',
                                  fontWeight: jc.flagged ? 700 : 500
                                }}>
                                  {jc.shortage !== null ? `${jc.shortage.toFixed(2)} m` : '--'}
                                  {jc.shortage !== null && (
                                    <span style={{ fontSize: '0.75rem', display: 'block', opacity: 0.8 }}>
                                      ({jc.shortage_pct.toFixed(2)}%)
                                    </span>
                                  )}
                                </td>
                                <td>
                                  <span className={`badge ${
                                    jc.status === 'closed' ? 'neutral' : jc.status === 'in-process' ? 'info' : 'warning'
                                  }`}>
                                    {jc.status}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>

                {/* Side: Worker Efficiency Tracker & Quick AI Status */}
                <div className="side-column">
                  {/* Worker Efficiency */}
                  <div className="card">
                    <h3 style={{ marginBottom: '1.25rem', fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <IconZap size={18} style={{ color: 'var(--primary)' }} />
                      Worker Efficiency
                    </h3>
                    {efficiency.length === 0 ? (
                      <div className="empty-state" style={{ padding: '1.5rem 0' }}>
                        <div className="empty-state-icon" style={{ display: 'flex', justifyContent: 'center' }}><IconZap size={48} /></div>
                        <div className="empty-state-text" style={{ fontSize: '0.85rem' }}>No efficiency reports yet</div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        {efficiency.map(eff => (
                          <div 
                            key={eff.id} 
                            style={{ 
                              background: 'rgba(255,255,255,0.02)', 
                              padding: '0.75rem 1rem', 
                              borderRadius: '10px', 
                              border: '1px solid var(--border-color)',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center'
                            }}
                          >
                            <div>
                              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>{eff.name}</div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{eff.section}</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ 
                                fontWeight: 700, 
                                fontSize: '1.1rem',
                                color: eff.flagged ? 'var(--danger)' : 'var(--success)' 
                              }}>
                                {eff.efficiency_pct.toFixed(1)}%
                              </div>
                              <span className={`badge ${eff.flagged ? 'danger' : 'success'}`} style={{ fontSize: '0.65rem', padding: '0.1rem 0.35rem', marginTop: '0.2rem' }}>
                                {eff.flagged ? 'Flagged' : 'Normal'}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* CCTV camera activities (Simulated Watch) */}
                  <div className="card">
                    <h3 style={{ marginBottom: '1.25rem', fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <IconTv size={18} style={{ color: 'var(--primary)' }} />
                      CCTV Edge Analytics
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {/* Station 1 */}
                      <div style={{ background: 'rgba(255,255,255,0.01)', padding: '0.75rem 1rem', borderRadius: '10px', border: '1px solid var(--border-color)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
                          <span style={{ fontWeight: 600 }}>Station A (Folding)</span>
                          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>45.0% Active</span>
                        </div>
                        <div style={{ height: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ width: '45%', height: '100%', background: 'var(--danger)' }} />
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem', display: 'flex', justifyContent: 'space-between' }}>
                          <span>Worker: Bharat Gohil</span>
                          <span>Idle: 180 min</span>
                        </div>
                      </div>

                      {/* Station 2 */}
                      <div style={{ background: 'rgba(255,255,255,0.01)', padding: '0.75rem 1rem', borderRadius: '10px', border: '1px solid var(--border-color)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
                          <span style={{ fontWeight: 600 }}>Station B (Weaving)</span>
                          <span style={{ color: 'var(--success)', fontWeight: 600 }}>82.5% Active</span>
                        </div>
                        <div style={{ height: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ width: '82.5%', height: '100%', background: 'var(--success)' }} />
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem', display: 'flex', justifyContent: 'space-between' }}>
                          <span>Worker: Arvind Makwana</span>
                          <span>Idle: 45 min</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB: STOCK INVENTORY */}
          {(activeTab === 'stock' || isWorkerMode) && (
            <div className="fade-in">
              <div className={isWorkerMode ? '' : 'content-layout'}>
                
                {/* Stock Capture Form & Manual Entry Column */}
                <div className="side-column">
                  
                  {/* Photo-based capture container */}
                  <div className="card">
                    <h2 className="form-section-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <IconCamera size={18} style={{ color: 'var(--primary)' }} />
                      AI Photo-Based Capture
                    </h2>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
                      Take a photo of the delivery challan or the folding meter display. The AI extracts lot, quality and meters automatically.
                    </p>

                    {/* Selector */}
                    <div className="form-group">
                      <label className="form-label">Capture Type / दस्तावेज़ का प्रकार</label>
                      <select 
                        className="form-select"
                        value={uploadType}
                        onChange={(e) => setUploadType(e.target.value as any)}
                        style={{ height: '44px', fontWeight: 600 }}
                      >
                        <option value="incoming_stock">Incoming Challan (IN)</option>
                        <option value="outgoing_stock">Outgoing Challan (OUT)</option>
                        <option value="job_card_folding">Folding Meter Display</option>
                      </select>
                    </div>

                    {/* File selector box */}
                    <div className="capture-box">
                      <div className="capture-box-icon" style={{ display: 'flex', justifyContent: 'center' }}><IconCamera size={36} /></div>
                      <div className="capture-box-text">Tap to open Camera / Select File</div>
                      <div className="capture-box-subtext">Supports PNG, JPG, WEBP</div>
                      <input 
                        type="file" 
                        accept="image/*"
                        capture="environment" // Triggers back camera on mobile devices
                        className="file-input-hidden" 
                        ref={fileInputRef}
                        onChange={handleFileChange}
                      />
                    </div>

                    {/* Image Preview */}
                    {previewUrl && (
                      <div className="image-preview-container">
                        <img src={previewUrl} alt="Preview" className="image-preview" />
                        <button
                          onClick={() => { setSelectedFile(null); setPreviewUrl(null); }}
                          style={{
                            position: 'absolute',
                            top: '10px',
                            right: '10px',
                            background: 'rgba(0,0,0,0.7)',
                            border: 'none',
                            color: 'white',
                            borderRadius: '50%',
                            width: '28px',
                            height: '28px',
                            cursor: 'pointer',
                            fontWeight: 'bold'
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    )}

                    {selectedFile && (
                      <button 
                        onClick={handlePhotoUpload} 
                        className="btn btn-primary pulse-glow"
                        disabled={isCapturing}
                        style={{ width: '100%', marginTop: '1.25rem', height: '48px' }}
                      >
                        {isCapturing ? 'AI Parsing Image...' : <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}><IconRocket size={16} /> Send to Textile Brain</span>}
                      </button>
                    )}

                    {/* Filename hint for low-confidence simulation */}
                    <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid var(--border-color)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      <IconInfo size={14} style={{ verticalAlign: 'middle', marginRight: '0.2rem' }} /> <strong>Simulation tip:</strong> The mock AI will automatically flag the reading as <strong>low-confidence</strong> (sending it to the Confirm Queue) if you upload a file with the name containing <code>low</code>, <code>blur</code>, or <code>pending</code>.
                    </div>
                  </div>

                  {/* Manual Entry Form (Hidden for worker role to enforce RBAC) */}
                  {!isWorkerMode && (
                    <div className="card">
                      <h2 className="form-section-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <IconEdit size={18} style={{ color: 'var(--primary)' }} />
                        Manual Stock Ledger Entry
                      </h2>
                      <form onSubmit={handleStockSubmit}>
                        <div className="form-group">
                          <label className="form-label">Transaction Type</label>
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button
                              type="button"
                              onClick={() => setStockForm(prev => ({ ...prev, direction: 'IN' }))}
                              className={`btn ${stockForm.direction === 'IN' ? 'btn-primary' : 'btn-secondary'}`}
                              style={{ flex: 1 }}
                            >
                              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                                <IconArrowDown size={16} /> Stock IN
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setStockForm(prev => ({ ...prev, direction: 'OUT' }))}
                              className={`btn ${stockForm.direction === 'OUT' ? 'btn-primary' : 'btn-secondary'}`}
                              style={{ flex: 1 }}
                            >
                              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                                <IconArrowUp size={16} /> Stock OUT
                              </span>
                            </button>
                          </div>
                        </div>

                        <div className="form-group">
                          <label className="form-label">Lot Number</label>
                          <input
                            type="text"
                            placeholder="e.g. LOT-5021"
                            className="form-input"
                            value={stockForm.lot_id}
                            onChange={(e) => setStockForm(prev => ({ ...prev, lot_id: e.target.value.toUpperCase() }))}
                          />
                        </div>

                        {stockForm.direction === 'IN' && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                            <div className="form-group">
                              <label className="form-label">Quality Name</label>
                              <input
                                type="text"
                                placeholder="e.g. Poly-Crepe"
                                className="form-input"
                                value={stockForm.quality}
                                onChange={(e) => setStockForm(prev => ({ ...prev, quality: e.target.value }))}
                              />
                            </div>
                            <div className="form-group">
                              <label className="form-label">Design #</label>
                              <input
                                type="text"
                                placeholder="e.g. Design-104A"
                                className="form-input"
                                value={stockForm.design}
                                onChange={(e) => setStockForm(prev => ({ ...prev, design: e.target.value }))}
                              />
                            </div>
                          </div>
                        )}

                        <div className="form-group">
                          <label className="form-label">Meters</label>
                          <input
                            type="number"
                            step="0.01"
                            placeholder="e.g. 520.45"
                            className="form-input"
                            value={stockForm.meters}
                            onChange={(e) => setStockForm(prev => ({ ...prev, meters: e.target.value }))}
                          />
                        </div>

                        <div className="form-group">
                          <label className="form-label">{stockForm.direction === 'IN' ? 'Supplier Name' : 'Buyer Client'}</label>
                          <input
                            type="text"
                            placeholder="e.g. Surat Weaving Ltd"
                            className="form-input"
                            value={stockForm.party}
                            onChange={(e) => setStockForm(prev => ({ ...prev, party: e.target.value }))}
                          />
                        </div>

                        <div className="form-group">
                          <label className="form-label">Challan / Ref #</label>
                          <input
                            type="text"
                            placeholder="e.g. CH-2991"
                            className="form-input"
                            value={stockForm.source_doc}
                            onChange={(e) => setStockForm(prev => ({ ...prev, source_doc: e.target.value.toUpperCase() }))}
                          />
                        </div>

                        <button type="submit" className="btn btn-success" style={{ width: '100%', height: '44px', marginTop: '0.5rem' }}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                            <IconSave size={16} /> Record Ledger Entry
                          </span>
                        </button>
                      </form>
                    </div>
                  )}

                </div>

                {/* Ledger Log Column (Hidden for worker role to enforce RBAC) */}
                {!isWorkerMode && (
                  <div className="main-column">
                    <div className="card">
                      <h2 style={{ marginBottom: '1.25rem', fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <IconBarChart size={18} style={{ color: 'var(--primary)' }} />
                        Central Ledger Logs (Append-Only)
                      </h2>
                      {ledger.length === 0 ? (
                        <div className="empty-state">
                          <div className="empty-state-icon" style={{ display: 'flex', justifyContent: 'center' }}><IconClipboard size={48} /></div>
                          <div className="empty-state-text">No ledger logs recorded yet</div>
                        </div>
                      ) : (
                        <div className="table-container">
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Timestamp</th>
                                <th>{t.lot}</th>
                                <th>Quality / Design</th>
                                <th>Direction</th>
                                <th>{t.meters}</th>
                                <th>{t.party}</th>
                                <th>Challan #</th>
                              </tr>
                            </thead>
                            <tbody>
                              {ledger.map(entry => (
                                <tr key={entry.id}>
                                  <td style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                    {new Date(entry.ts).toLocaleString()}
                                  </td>
                                  <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{entry.lot_id}</td>
                                  <td>
                                    <div style={{ fontWeight: 500 }}>{entry.quality}</div>
                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{entry.design}</span>
                                  </td>
                                  <td>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontWeight: 700 }}>
                                      <span className={`dot ${entry.direction === 'IN' ? 'in' : 'out'}`} />
                                      {entry.direction}
                                    </span>
                                  </td>
                                  <td style={{ fontWeight: 700, color: entry.direction === 'IN' ? 'var(--success)' : 'var(--danger)' }}>
                                    {entry.direction === 'IN' ? '+' : '-'}{entry.meters.toFixed(2)} m
                                  </td>
                                  <td>{entry.party || '--'}</td>
                                  <td>
                                    <span style={{ fontFamily: 'monospace', background: 'rgba(255,255,255,0.03)', padding: '0.2rem 0.4rem', borderRadius: '4px', fontSize: '0.8rem' }}>
                                      {entry.source_doc_id || '--'}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                )}

              </div>
            </div>
          )}

          {/* TAB: JOB CARDS */}
          {activeTab === 'jobcards' && !isWorkerMode && (
            <div className="fade-in">
              <div className="content-layout">
                {/* Active Job Cards Ledger */}
                <div className="main-column">
                  <div className="card">
                    <h2 style={{ marginBottom: '1.25rem', fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <IconClipboard size={18} style={{ color: 'var(--primary)' }} />
                      Production Job Cards
                    </h2>
                    {jobCards.length === 0 ? (
                      <div className="empty-state">
                        <div className="empty-state-icon" style={{ display: 'flex', justifyContent: 'center' }}><IconFileText size={48} /></div>
                        <div className="empty-state-text">No job cards available</div>
                      </div>
                    ) : (
                      <div className="table-container">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>JC ID</th>
                              <th>{t.lot}</th>
                              <th>Quality / Design</th>
                              <th>Process</th>
                              <th>Assigned Operator</th>
                              <th>Meters In</th>
                              <th>Meters Out</th>
                              <th>{t.shortage}</th>
                              <th>{t.status}</th>
                              <th>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {jobCards.map(jc => (
                              <tr key={jc.id}>
                                <td style={{ color: 'var(--text-muted)' }}>#{jc.id}</td>
                                <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{jc.lot_id}</td>
                                <td>
                                  <div>{jc.quality}</div>
                                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{jc.design}</span>
                                </td>
                                <td style={{ fontWeight: 500 }}>{jc.process}</td>
                                <td>
                                  <div>{jc.worker_name}</div>
                                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{jc.worker_section}</span>
                                </td>
                                <td>{jc.meters_in.toFixed(2)} m</td>
                                <td>{jc.meters_out !== null ? `${jc.meters_out.toFixed(2)} m` : '--'}</td>
                                <td style={{ 
                                  color: jc.flagged ? 'var(--danger)' : jc.shortage !== null ? 'var(--text-secondary)' : 'var(--text-muted)',
                                  fontWeight: jc.flagged ? 700 : 500
                                }}>
                                  {jc.shortage !== null ? `${jc.shortage.toFixed(2)} m` : '--'}
                                  {jc.shortage !== null && (
                                    <span style={{ fontSize: '0.75rem', display: 'block', opacity: 0.8 }}>
                                      ({jc.shortage_pct.toFixed(2)}%)
                                    </span>
                                  )}
                                  {jc.flagged && (
                                    <span className="badge danger" style={{ fontSize: '0.6rem', padding: '0.1rem 0.3rem', marginTop: '0.2rem' }}>
                                      High Shortage
                                    </span>
                                  )}
                                </td>
                                <td>
                                  <span className={`badge ${
                                    jc.status === 'closed' ? 'neutral' : jc.status === 'in-process' ? 'info' : 'warning'
                                  }`}>
                                    {jc.status}
                                  </span>
                                </td>
                                <td>
                                  {jc.status !== 'closed' && (
                                    <div>
                                      {completingJobCardId === jc.id ? (
                                        <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                                          <input
                                            type="number"
                                            placeholder="Out m"
                                            className="form-input"
                                            style={{ width: '80px', height: '32px', padding: '0.2rem' }}
                                            value={metersOutInput}
                                            onChange={(e) => setMetersOutInput(e.target.value)}
                                          />
                                          <button 
                                            onClick={() => handleManualCompleteFolding(jc.id)}
                                            className="btn btn-success"
                                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                          >
                                            ✓
                                          </button>
                                          <button 
                                            onClick={() => setCompletingJobCardId(null)}
                                            className="btn btn-secondary"
                                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                          >
                                            ✕
                                          </button>
                                        </div>
                                      ) : (
                                        <button
                                          onClick={() => { setCompletingJobCardId(jc.id); setMetersOutInput(''); }}
                                          className="btn btn-primary"
                                          style={{ padding: '0.4rem 0.75rem', fontSize: '0.75rem' }}
                                        >
                                          <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}><IconFlag size={12} /> Complete</span>
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>

                {/* Create Job Card Column */}
                <div className="side-column">
                  <div className="card">
                    <h2 className="form-section-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <IconPlus size={18} style={{ color: 'var(--primary)' }} />
                      Create Job Card
                    </h2>
                    <form onSubmit={handleJobCardSubmit}>
                      <div className="form-group">
                        <label className="form-label">Lot Number</label>
                        <select
                          className="form-select"
                          value={jobCardForm.lot_id}
                          onChange={(e) => setJobCardForm(prev => ({ ...prev, lot_id: e.target.value }))}
                        >
                          <option value="">-- Select Fabric Lot --</option>
                          {lots.map(lot => (
                            <option key={lot.lot_id} value={lot.lot_id}>
                              {lot.lot_id} - {lot.quality} ({lot.balance.toFixed(1)}m available)
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="form-group">
                        <label className="form-label">Process Stage</label>
                        <select
                          className="form-select"
                          value={jobCardForm.process}
                          onChange={(e) => setJobCardForm(prev => ({ ...prev, process: e.target.value }))}
                        >
                          <option value="Weaving">Weaving (बुनाई)</option>
                          <option value="Dyeing">Dyeing (रंगाई)</option>
                          <option value="Printing">Printing (छपाई)</option>
                          <option value="Folding">Folding (तह लगाना)</option>
                        </select>
                      </div>

                      <div className="form-group">
                        <label className="form-label">Allot Operator / Assigned Worker</label>
                        <select
                          className="form-select"
                          value={jobCardForm.worker_id}
                          onChange={(e) => setJobCardForm(prev => ({ ...prev, worker_id: e.target.value }))}
                        >
                          <option value="">-- Select Worker --</option>
                          {workers.map(w => (
                            <option key={w.id} value={w.id}>
                              {w.name} - {w.section}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="form-group">
                        <label className="form-label">Meters In (कच्चा मीटर)</label>
                        <input
                          type="number"
                          step="0.01"
                          placeholder="e.g. 500.00"
                          className="form-input"
                          value={jobCardForm.meters_in}
                          onChange={(e) => setJobCardForm(prev => ({ ...prev, meters_in: e.target.value }))}
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label">Shift</label>
                        <select
                          className="form-select"
                          value={jobCardForm.shift}
                          onChange={(e) => setJobCardForm(prev => ({ ...prev, shift: e.target.value }))}
                        >
                          <option value="Morning">Morning (सुबह)</option>
                          <option value="Evening">Evening (शाम)</option>
                          <option value="Night">Night (रात)</option>
                        </select>
                      </div>

                      <button type="submit" className="btn btn-primary" style={{ width: '100%', height: '44px', marginTop: '0.5rem' }}>
                        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                          <IconPlus size={16} /> Dispatch Job Card & Allot Work
                        </span>
                      </button>
                    </form>
                  </div>

                  {/* Active Allotments List */}
                  <div className="card">
                    <h3 style={{ marginBottom: '1rem', fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <IconCalendar size={18} style={{ color: 'var(--primary)' }} />
                      Today's Shift Allotments
                    </h3>
                    {allotments.length === 0 ? (
                      <div className="empty-state" style={{ padding: '1.5rem 0' }}>
                        <div className="empty-state-text" style={{ fontSize: '0.85rem' }}>No allotments recorded today</div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                        {allotments.map(allot => (
                          <div 
                            key={allot.id} 
                            style={{ 
                              background: 'rgba(255,255,255,0.01)', 
                              padding: '0.6rem 0.8rem', 
                              borderRadius: '8px', 
                              border: '1px solid var(--border-color)',
                              fontSize: '0.8rem'
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                              <strong style={{ color: 'var(--text-primary)' }}>{allot.worker_name}</strong>
                              <span style={{ color: 'var(--secondary)' }}>{allot.shift} Shift</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                              <span>Lot: {allot.lot_id} ({allot.process})</span>
                              <span>Allotted: {allot.meters_allotted.toFixed(1)}m</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB: CONFIRM QUEUE */}
          {activeTab === 'confirmqueue' && !isWorkerMode && (
            <div className="fade-in">
              <h2 style={{ marginBottom: '1.5rem', fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><IconSearch size={22} style={{ color: 'var(--primary)' }} /> AI OCR Verification Queue</span>
                <span className="logo-badge" style={{ background: 'var(--warning-glow)', color: 'var(--warning)', borderColor: 'rgba(245, 158, 11, 0.3)' }}>
                  Requires Approval
                </span>
              </h2>

              {captureEvents.filter(e => e.status === 'pending').length === 0 ? (
                <div className="card" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
                  <div className="empty-state-icon" style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}><IconCheck size={48} style={{ color: 'var(--success)' }} /></div>
                  <h3>Verification Queue is Empty!</h3>
                  <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem', fontSize: '0.9rem' }}>
                    All AI vision extractions were highly confident and auto-committed, or have been reviewed.
                  </p>
                </div>
              ) : (
                <div className="confirm-queue-grid">
                  {captureEvents
                    .filter(e => e.status === 'pending')
                    .map(event => {
                      const isCorrecting = correctingEventId === event.id;
                      
                      return (
                        <div key={event.id} className="confirm-item">
                          
                          {/* Image Box */}
                          <div className="confirm-image-container">
                            <div style={{ position: 'absolute', top: '10px', left: '10px', background: 'rgba(0,0,0,0.6)', padding: '0.25rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', color: 'white', fontWeight: 600 }}>
                              Capture Event #{event.id}
                            </div>
                            {/* In production, this renders the real uploaded photo */}
                            {/* For demo, we show a premium icon/tag indicating it's the uploaded challan */}
                            <div style={{ textAlign: 'center', padding: '1rem' }}>
                              <span style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.5rem', color: 'var(--text-muted)' }}><IconFile size={48} /></span>
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                                {event.photo_url}
                              </span>
                              <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                                Captured {new Date(event.ts).toLocaleTimeString()}
                              </span>
                            </div>
                          </div>

                          {/* Details & Actions */}
                          <div className="confirm-details">
                            <div>
                              {/* Confidence score */}
                              <div className="confidence-indicator">
                                <span>Low Confidence Read: {Math.round(event.confidence * 100)}%</span>
                                <div className="confidence-bar">
                                  <div className="confidence-fill" style={{ width: `${event.confidence * 100}%` }} />
                                </div>
                              </div>

                              <h3 style={{ marginBottom: '1rem' }}>
                                {event.type === 'incoming_stock' && 'Extracted Incoming Challan Data'}
                                {event.type === 'outgoing_stock' && 'Extracted Outgoing Dispatch Data'}
                                {event.type === 'job_card_folding' && 'Extracted Folding Meter Reading'}
                              </h3>

                              {/* Interactive Form for correction */}
                              <div className="confirm-fields-grid">
                                {event.type === 'incoming_stock' && (
                                  <>
                                    <div className="form-group">
                                      <label className="form-label">{t.lot}</label>
                                      <input 
                                        type="text" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.lot_id || '' : event.ai_json?.lot_id || ''}
                                        onChange={(e) => handleCorrectionFieldChange('lot_id', e.target.value.toUpperCase())}
                                      />
                                    </div>
                                    <div className="form-group">
                                      <label className="form-label">{t.quality}</label>
                                      <input 
                                        type="text" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.quality || '' : event.ai_json?.quality || ''}
                                        onChange={(e) => handleCorrectionFieldChange('quality', e.target.value)}
                                      />
                                    </div>
                                    <div className="form-group">
                                      <label className="form-label">{t.design}</label>
                                      <input 
                                        type="text" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.design || '' : event.ai_json?.design || ''}
                                        onChange={(e) => handleCorrectionFieldChange('design', e.target.value)}
                                      />
                                    </div>
                                    <div className="form-group">
                                      <label className="form-label">{t.meters}</label>
                                      <input 
                                        type="number" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.meters || '' : event.ai_json?.meters || ''}
                                        onChange={(e) => handleCorrectionFieldChange('meters', e.target.value)}
                                      />
                                    </div>
                                    <div className="form-group">
                                      <label className="form-label">{t.party}</label>
                                      <input 
                                        type="text" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.party || '' : event.ai_json?.party || ''}
                                        onChange={(e) => handleCorrectionFieldChange('party', e.target.value)}
                                      />
                                    </div>
                                    <div className="form-group">
                                      <label className="form-label">{t.sourceDoc}</label>
                                      <input 
                                        type="text" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.source_doc || '' : event.ai_json?.source_doc || ''}
                                        onChange={(e) => handleCorrectionFieldChange('source_doc', e.target.value.toUpperCase())}
                                      />
                                    </div>
                                  </>
                                )}

                                {event.type === 'outgoing_stock' && (
                                  <>
                                    <div className="form-group">
                                      <label className="form-label">{t.lot}</label>
                                      <input 
                                        type="text" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.lot_id || '' : event.ai_json?.lot_id || ''}
                                        onChange={(e) => handleCorrectionFieldChange('lot_id', e.target.value.toUpperCase())}
                                      />
                                    </div>
                                    <div className="form-group">
                                      <label className="form-label">{t.meters}</label>
                                      <input 
                                        type="number" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.meters || '' : event.ai_json?.meters || ''}
                                        onChange={(e) => handleCorrectionFieldChange('meters', e.target.value)}
                                      />
                                    </div>
                                    <div className="form-group">
                                      <label className="form-label">{t.party}</label>
                                      <input 
                                        type="text" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.party || '' : event.ai_json?.party || ''}
                                        onChange={(e) => handleCorrectionFieldChange('party', e.target.value)}
                                      />
                                    </div>
                                    <div className="form-group">
                                      <label className="form-label">{t.sourceDoc}</label>
                                      <input 
                                        type="text" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.source_doc || '' : event.ai_json?.source_doc || ''}
                                        onChange={(e) => handleCorrectionFieldChange('source_doc', e.target.value.toUpperCase())}
                                      />
                                    </div>
                                  </>
                                )}

                                {event.type === 'job_card_folding' && (
                                  <>
                                    <div className="form-group">
                                      <label className="form-label">Job Card ID</label>
                                      <input 
                                        type="number" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.job_card_id || '' : event.ai_json?.job_card_id || ''}
                                        onChange={(e) => handleCorrectionFieldChange('job_card_id', e.target.value)}
                                      />
                                    </div>
                                    <div className="form-group">
                                      <label className="form-label">{t.lot}</label>
                                      <input 
                                        type="text" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.lot_id || '' : event.ai_json?.lot_id || ''}
                                        onChange={(e) => handleCorrectionFieldChange('lot_id', e.target.value.toUpperCase())}
                                      />
                                    </div>
                                    <div className="form-group">
                                      <label className="form-label">{t.foldingMeters}</label>
                                      <input 
                                        type="number" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.meters_out || '' : event.ai_json?.meters_out || ''}
                                        onChange={(e) => handleCorrectionFieldChange('meters_out', e.target.value)}
                                      />
                                    </div>
                                    <div className="form-group">
                                      <label className="form-label">Worker ID</label>
                                      <input 
                                        type="text" 
                                        className="form-input"
                                        disabled={!isCorrecting}
                                        value={isCorrecting ? correctedData.worker_id || '' : event.ai_json?.worker_id || ''}
                                        onChange={(e) => handleCorrectionFieldChange('worker_id', e.target.value)}
                                      />
                                    </div>
                                  </>
                                )}
                              </div>
                            </div>

                            {/* Actions bar */}
                            <div className="confirm-actions">
                              <button 
                                onClick={() => handleRejectEvent(event.id)}
                                className="btn btn-secondary"
                                style={{ color: 'var(--danger)', borderColor: 'rgba(239, 68, 68, 0.2)' }}
                              >
                                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><IconTrash2 size={14} /> {t.reject}</span>
                              </button>

                              {isCorrecting ? (
                                <>
                                  <button 
                                    onClick={() => handleConfirmEvent(event, true)}
                                    className="btn btn-success"
                                  >
                                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}><IconSave size={14} /> Save & Confirm</span>
                                  </button>
                                  <button 
                                    onClick={() => setCorrectingEventId(null)}
                                    className="btn btn-secondary"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button 
                                    onClick={() => startCorrecting(event)}
                                    className="btn btn-secondary"
                                  >
                                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><IconEdit size={14} /> {t.correct}</span>
                                  </button>
                                  <button 
                                    onClick={() => handleConfirmEvent(event, false)}
                                    className="btn btn-primary"
                                  >
                                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><IconCheck size={14} /> Quick {t.confirm}</span>
                                  </button>
                                </>
                              )}
                            </div>

                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}

          {/* TAB: CHAT ASSISTANT */}
          {activeTab === 'chat' && !isWorkerMode && (
            <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 260px)', minHeight: '520px' }}>
              <h2 style={{ marginBottom: '1.25rem', fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><IconBrain size={20} style={{ color: 'var(--primary)' }} /> AI Brain Chat Assistant</span>
                <span className="logo-badge" style={{ background: 'var(--success-glow)', color: 'var(--success)', borderColor: 'rgba(16, 185, 129, 0.3)' }}>
                  Active DB Access
                </span>
              </h2>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem', flexGrow: 1, overflow: 'hidden' }}>
                <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '1.25rem', background: 'var(--bg-card)' }}>
                  
                  {/* Messages list */}
                  <div style={{ flexGrow: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1rem', marginBottom: '1rem', background: 'rgba(0, 0, 0, 0.2)', borderRadius: '12px', border: '1px solid var(--border-color)', minHeight: '200px' }}>
                    {messages.map((msg, idx) => (
                      <div 
                        key={idx} 
                        style={{ 
                          alignSelf: msg.sender === 'user' ? 'flex-end' : 'flex-start',
                          maxWidth: '85%',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.4rem'
                        }}
                      >
                        <div style={{ 
                          background: msg.sender === 'user' ? 'var(--primary)' : 'rgba(0, 0, 0, 0.03)',
                          color: msg.sender === 'user' ? '#ffffff' : 'var(--text-primary)',
                          padding: '0.8rem 1.2rem',
                          borderRadius: msg.sender === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                          border: msg.sender === 'user' ? 'none' : '1px solid var(--border-color)',
                          fontSize: '0.92rem',
                          boxShadow: msg.sender === 'user' ? '0 4px 10px var(--primary-glow)' : 'none'
                        }}>
                          {msg.loading ? (
                            <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', padding: '0.2rem' }}>
                              <span style={{ width: '6px', height: '6px', background: msg.sender === 'user' ? '#ffffff' : 'var(--text-secondary)', borderRadius: '50%', animation: 'bounce 1.4s infinite ease-in-out both' }}></span>
                              <span style={{ width: '6px', height: '6px', background: msg.sender === 'user' ? '#ffffff' : 'var(--text-secondary)', borderRadius: '50%', animation: 'bounce 1.4s infinite ease-in-out both 0.2s' }}></span>
                              <span style={{ width: '6px', height: '6px', background: msg.sender === 'user' ? '#ffffff' : 'var(--text-secondary)', borderRadius: '50%', animation: 'bounce 1.4s infinite ease-in-out both 0.4s' }}></span>
                            </div>
                          ) : (
                            <div style={{ whiteSpace: 'pre-wrap' }}>
                              {msg.text.split('**').map((part, i) => i % 2 === 1 ? <strong key={i} style={{ color: msg.sender === 'user' ? '#ffffff' : 'var(--primary)' }}>{part}</strong> : part)}
                            </div>
                          )}
                        </div>

                        {/* SQL and Supporting Rows Inspector */}
                        {!msg.loading && msg.sql && (
                          <div style={{ marginTop: '0.2rem', alignSelf: 'flex-start', width: '100%' }}>
                            <button
                              type="button"
                              onClick={() => setActiveSqlId(activeSqlId === idx ? null : idx)}
                              style={{
                                color: 'var(--text-secondary)',
                                fontSize: '0.75rem',
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.3rem',
                                padding: '0.2rem 0.5rem',
                                borderRadius: '4px',
                                background: 'rgba(255,255,255,0.02)',
                                border: '1px solid var(--border-color)'
                              }}
                            >
                              <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}><IconSettings size={14} /> {activeSqlId === idx ? 'Hide Technical Details' : 'Show SQL & Data'}</span>
                            </button>

                            {activeSqlId === idx && (
                              <div className="fade-in" style={{ marginTop: '0.5rem', padding: '0.75rem', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                {/* SQL query box */}
                                <div>
                                  <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '0.25rem' }}>
                                    Executed SQL (Read-Only)
                                  </div>
                                  <pre style={{ margin: 0, padding: '0.5rem', background: '#05070f', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '6px', color: '#818cf8', fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
                                    {msg.sql}
                                  </pre>
                                </div>

                                {/* Supporting data rows */}
                                {msg.rows && msg.rows.length > 0 && (
                                  <div>
                                    <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '0.25rem' }}>
                                      Supporting Database Records ({msg.rows.length} rows)
                                    </div>
                                    <div className="table-container" style={{ maxHeight: '180px', overflowY: 'auto' }}>
                                      <table className="data-table" style={{ fontSize: '0.8rem' }}>
                                        <thead>
                                          <tr>
                                            {Object.keys(msg.rows[0]).map((key) => (
                                              <th key={key} style={{ padding: '0.4rem 0.6rem', fontSize: '0.75rem' }}>{key}</th>
                                            ))}
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {msg.rows.map((row, rIdx) => (
                                            <tr key={rIdx}>
                                              {Object.values(row).map((val: any, cIdx) => (
                                                <td key={cIdx} style={{ padding: '0.4rem 0.6rem', color: 'var(--text-primary)' }}>
                                                  {val === null ? 'null' : typeof val === 'object' ? JSON.stringify(val) : String(val)}
                                                </td>
                                              ))}
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Suggestion Chips */}
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem', padding: '0.2rem' }}>
                    <span style={{ fontSize: '0.75rem', alignSelf: 'center', color: 'var(--text-muted)', fontWeight: 600 }}>Suggestions:</span>
                    {[
                      'List all active lots',
                      'Show stock balance of LOT-5021',
                      'What is our total running stock?',
                      'List job cards with shortages',
                      'Which workers are slow or inefficient?'
                    ].map((chip) => (
                      <button
                        key={chip}
                        type="button"
                        onClick={() => handleChatSubmit(undefined, chip)}
                        style={{
                          background: 'rgba(255,255,255,0.03)',
                          border: '1px solid var(--border-color)',
                          color: 'var(--text-secondary)',
                          fontSize: '0.75rem',
                          padding: '0.35rem 0.7rem',
                          borderRadius: '20px',
                          cursor: 'pointer',
                          transition: 'all 0.2s'
                        }}
                      >
                        {chip}
                      </button>
                    ))}
                  </div>

                  {/* Input Form */}
                  <form onSubmit={handleChatSubmit} style={{ display: 'flex', gap: '0.75rem' }}>
                    <input
                      type="text"
                      placeholder="Ask the Brain a question (e.g. 'what is the quality of LOT-5021?')..."
                      className="form-input"
                      style={{ height: '48px', flexGrow: 1, fontSize: '0.95rem' }}
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                    />
                    <button type="submit" className="btn btn-primary" style={{ width: '110px', height: '48px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
                        Send <IconSend size={14} />
                      </span>
                    </button>
                  </form>

                </div>
              </div>
            </div>
          )}
        </>
      )}
      
      {/* Footer */}
      <footer style={{ marginTop: 'auto', padding: '2rem 0', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
        <span>© 2026 Surat Textile Wholesalers Association Platform</span>
        <span>AI Vision Provider: <strong>Claude 3.5 Sonnet / Edge Box</strong></span>
      </footer>
    </div>
  );
}

// Utility style helpers
const varColors = (status?: string) => {
  if (status === 'ok') return { text: 'var(--success)' };
  return { text: 'var(--danger)' };
};
