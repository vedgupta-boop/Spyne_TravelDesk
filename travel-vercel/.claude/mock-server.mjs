import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { POLICY, CONFIG } from '../lib/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Signed-in finance superuser + HOD (sees every dashboard, incl. the HOD/My views)
const ME = { authenticated: true, email: 'finance.demo@spyne.ai', name: 'Finance Demo', roles: ['requester', 'hod', 'ceo', 'finance', 'admin', 'forex'] };
const CONFIG_RES = { company: CONFIG.COMPANY_NAME, domain: CONFIG.COMPANY_DOMAIN, departments: CONFIG.DEPARTMENTS, policy: POLICY, userEmail: ME.email,
  fx: CONFIG.FX, reportingCurrency: CONFIG.REPORTING_CURRENCY, deptBudgets: CONFIG.DEPT_BUDGETS, flightSearch: false };

// ---- Approvals dashboard (scoped to the signed-in approver) ----
const APPROVALS = { scope: 'Technology', rows: [
  { id: 'TRF-20260918-PEN1', name: 'Arjun Nair', email: 'arjun@spyne.ai', dept: 'Technology', type: 'international', trip: 'Round trip',
    purpose: 'Client Meeting', route: 'Bengaluru → New York', start: '18 Sep 2026', end: '22 Sep 2026', submission: '17 Jun 2026',
    currency: 'USD', total: 2785, estimatedCost: 'USD 2,785', flag: 'POLICY BREAK: Transport USD 800 over cap USD 900; Short notice — 10d (needs 30d)',
    breakdown: { transport: 800, mode: 'Flight (Economy)', hotel: 520, hotelRate: 130, hotelNights: 4, meals: 350, mealRate: 70, local: 490, other: 225, extras: { visa: 185, insurance: 25, phone: 20 }, forex: 625, deposit: 100, days: 5 },
    advForex: 625, advDeposit: 100, advance: 725, pax: 3, passengers: ['Arjun Nair', 'Sanjay Kumar', 'Deepti Sharma'],
    stage: 'dept', myStage: 'dept', status: 'Pending HOD Approval', pending: true, held: false, decision: '', decisionDate: '', comments: '',
    canApproveReimburse: true,
    flights: [ { label: 'Outbound', from: 'Bengaluru (BLR)', to: 'New York (JFK)', date: '18 Sep 2026', timeLabel: '01:30 IST · 16:00 −1 ET' }, { label: 'Extra flight 1', from: 'New York (JFK)', to: 'Chicago (ORD)', date: '24 Sep 2026', timeLabel: '09:10 ET' }, { label: 'Return', from: 'Chicago (ORD)', to: 'Bengaluru (BLR)', date: '22 Sep 2026', timeLabel: '14:20 CT · 04:50 +1 IST' } ],
    hotels: [ { label: 'Stay (destination)', city: 'New York', checkIn: '18 Sep 2026', checkOut: '24 Sep 2026', nights: 6 }, { label: 'Stay', city: 'Chicago', checkIn: '24 Sep 2026', checkOut: '26 Sep 2026', nights: 2 } ],
    recon: { available: true, linked: 2, estimateINR: 256220, actualINR: 210000, paidINR: 150000, varianceINR: 46220, settlementINR: -143300, items: [ { id:'EXP-201', item:'Hotel', vendor:'Hilton', category:'Travel', amount:1500, currency:'USD', amountINR:138000, status:'Paid', paid:true }, { id:'EXP-202', item:'Meals & cabs', vendor:'—', category:'Travel', amount:783, currency:'USD', amountINR:72000, status:'Pending Finance', paid:false } ] },
    actuals: { status:'Submitted', currency:'USD', hasActuals:true, estTotal:2390, actualTotal:2050, variance:340, reimbursable:475, advance:725, reimburseApproved:0, items:[ {key:'flight',label:'Flight',estimate:800,actual:850,paidBy:'company',doc:'#',variance:-50}, {key:'hotel',label:'Hotel',estimate:520,actual:540,paidBy:'company',doc:'#',variance:-20}, {key:'meals',label:'Meals',estimate:280,actual:300,paidBy:'own',doc:'#',variance:-20}, {key:'local',label:'Local conveyance',estimate:200,actual:150,paidBy:'own',doc:'#',variance:50}, {key:'misc',label:'Misc',estimate:0,actual:25,paidBy:'own',doc:'#',variance:-25} ] } },
  { id: 'TRF-20260915-PEN2', name: 'Neha Singh', email: 'neha@spyne.ai', dept: 'Technology', type: 'domestic', trip: 'Round trip',
    purpose: 'Site Visit', route: 'Mumbai → Delhi', start: '15 Sep 2026', end: '16 Sep 2026', submission: '17 Jun 2026',
    currency: 'INR', total: 21800, estimatedCost: 'INR 21,800', flag: 'Within policy',
    breakdown: { transport: 9000, mode: 'Flight (Economy)', hotel: 6000, hotelRate: 6000, hotelNights: 1, meals: 1600, mealRate: 800, local: 5200, other: 0, forex: 0, days: 2 },
    stage: 'dept', myStage: 'dept', status: 'Pending HOD Approval', pending: true, held: false, decision: '', decisionDate: '', comments: '' },
  { id: 'TRF-20260910-HLD3', name: 'Imran Khan', email: 'imran@spyne.ai', dept: 'Technology', type: 'domestic', trip: 'Round trip',
    purpose: 'Vendor Visit', route: 'Bengaluru → Chennai', start: '10 Sep 2026', end: '12 Sep 2026', submission: '16 Jun 2026',
    currency: 'INR', total: 18400, estimatedCost: 'INR 18,400', flag: 'Within policy',
    breakdown: { transport: 9000, mode: 'Flight (Economy)', hotel: 6000, hotelRate: 6000, hotelNights: 1, meals: 1600, mealRate: 800, local: 1800, other: 0, forex: 0, days: 2 },
    stage: 'dept', myStage: 'dept', status: 'On Hold — Department Head', pending: false, held: true, decision: '', decisionDate: '',
    comments: '[Department Head · jatin · 17 Jun 2026] Holding — please confirm the client meeting is finalised before I approve.' },
  { id: 'TRF-20260901-AB12', name: 'Priya Sharma', email: 'priya@spyne.ai', dept: 'Technology', type: 'international', trip: 'Round trip',
    purpose: 'Conference / Event', route: 'Bengaluru → London', start: '01 Sep 2026', end: '05 Sep 2026', submission: '16 Jun 2026',
    currency: 'USD', total: 2390, estimatedCost: 'USD 2,390', flag: 'Within policy',
    breakdown: { transport: 800, mode: 'Flight (Economy)', hotel: 520, hotelRate: 130, hotelNights: 4, meals: 350, mealRate: 70, local: 220, other: 0, forex: 500, days: 5 },
    stage: 'arrange', myStage: 'dept', status: 'Approved — With Admin for Arrangements', pending: false, held: false, decision: 'Approved', decisionDate: '16 Jun 2026',
    comments: '[Department Head · jatin · 16 Jun 2026] Approved — aligns with the Q3 conference plan.' },
  { id: 'TRF-20260820-RJ55', name: 'Karan Mehta', email: 'karan@spyne.ai', dept: 'Technology', type: 'domestic', trip: 'One-way',
    purpose: 'Training', route: 'Pune → Hyderabad', start: '20 Aug 2026', end: '', submission: '15 Jun 2026',
    currency: 'INR', total: 12000, estimatedCost: 'INR 12,000', flag: 'Within policy',
    breakdown: { transport: 9000, mode: 'Flight (Economy)', hotel: 0, hotelRate: 0, hotelNights: 0, meals: 800, mealRate: 800, local: 2200, other: 0, forex: 0, days: 1 },
    stage: 'rejected', myStage: 'dept', status: 'Rejected at Department Head', pending: false, held: false, decision: 'Rejected', decisionDate: '15 Jun 2026',
    comments: '[Department Head · jatin · 15 Jun 2026] Rejected — this training can be done remotely.' },
] };

// ---- My Requests (requester self-service) ----
const MINE = { rows: [
  { id: 'TRF-20260918-MINE1', type: 'domestic', trip: 'Round trip', purpose: 'Site Visit', route: 'Delhi (DEL) → Mumbai (BOM)', traveller: 'Finance Demo', raisedForOther: false,
    start: '18 Sep 2026', end: '20 Sep 2026', submission: '17 Jun 2026', stage: 'dept', status: 'Pending HOD Approval',
    hod: 'Pending', ceo: 'N/A', finance: 'N/A', booking: '', forexIssued: 'N/A',
    pendingWith: 'jatin@spyne.ai', pendingStage: 'Department Head',
    canEdit: true, canWithdraw: true,
    edit: { dept: 'Technology', travelType: 'domestic', tripType: 'round', from: 'Delhi (DEL)', to: 'Mumbai (BOM)', returnFrom: 'Mumbai (BOM)', returnTo: 'Delhi (DEL)', startDate: '2026-09-18', returnDate: '2026-09-20', purpose: 'Site Visit', transportMode: 'Flight (Economy)', notes: '', forexNeeded: false, visaNeeded: false, extraFlights: [], extraHotels: [], extraPassengers: [] },
    timeline: { steps: [ { label: 'Submitted', status: 'done', date: '17 Jun 2026' }, { label: 'HOD', status: 'pending', date: '' }, { label: 'Booking', status: 'pending', date: '' } ], comments: [] } },
  { id: 'TRF-20260905-MINE2', type: 'domestic', trip: 'Round trip', purpose: 'Site Visit', route: 'Mumbai → Delhi', traveller: 'Ravi Kumar', raisedForOther: true,
    start: '05 Sep 2026', end: '07 Sep 2026', submission: '16 Jun 2026', stage: 'arrange', status: 'Approved — With Admin for Arrangements',
    hod: 'Approved', ceo: 'N/A', finance: 'N/A', booking: 'Pending', forexIssued: 'N/A',
    pendingWith: 'shankul.rastogi@spyne.ai', pendingStage: 'Admin (booking)',
    canEdit: false, canWithdraw: true, canAddFlightDoc: true, prefFlightDoc: '', prefFlightNotes: 'Prefer morning non-stop, IndiGo',
    flights: [ { label: 'Outbound', from: 'Mumbai', to: 'Delhi', date: '05 Sep 2026', time: '08:30', timeLabel: '08:30 IST' }, { label: 'Return', from: 'Delhi', to: 'Mumbai', date: '07 Sep 2026', time: '19:15', timeLabel: '19:15 IST' } ],
    edit: {}, timeline: { steps: [ { label: 'Submitted', status: 'done', date: '16 Jun 2026' }, { label: 'HOD', status: 'done', date: '16 Jun 2026' }, { label: 'Booking', status: 'pending', date: '' } ], comments: [ '[Department Head · jatin · 16 Jun 2026] Approved.' ] } },
  { id: 'TRF-20260801-MINE3', type: 'international', trip: 'Round trip', purpose: 'Conference / Event', route: 'Mumbai → London', traveller: 'Finance Demo', raisedForOther: false,
    start: '01 Aug 2026', end: '05 Aug 2026', submission: '12 Jun 2026', stage: 'done', status: 'Completed — Forex card issued',
    hod: 'Approved', ceo: 'Approved', finance: 'Approved', booking: 'Completed', forexIssued: 'Issued',
    canEdit: false, canWithdraw: false, canAddFlightDoc: false, prefFlightDoc: '#doc', prefFlightNotes: 'Direct BA flight requested',
    flights: [ { label: 'Outbound', from: 'Mumbai', to: 'London', date: '01 Aug 2026', time: '02:10', timeLabel: '02:10 IST · 21:40 −1 BST' }, { label: 'Return', from: 'London', to: 'Mumbai', date: '05 Aug 2026', time: '13:25', timeLabel: '13:25 BST · 17:55 IST' } ],
    edit: {}, timeline: { steps: [ { label: 'Submitted', status: 'done', date: '12 Jun 2026' }, { label: 'HOD', status: 'done', date: '12 Jun 2026' }, { label: 'CEO', status: 'done', date: '13 Jun 2026' }, { label: 'Booking', status: 'done', date: '14 Jun 2026', note: 'BA138 · PNR XYZ987' }, { label: 'Forex card', status: 'done', date: '15 Jun 2026' } ], comments: [] },
    canAddActuals: true, canAddForexCard: true, forexCardDoc: '',
    actuals: { status:'Pending', currency:'USD', hasActuals:false, estTotal:2390, actualTotal:0, variance:2390, reimbursable:0, advance:725, reimburseApproved:0, items:[ {key:'flight',label:'Flight',estimate:800,actual:0,paidBy:'company',doc:'',variance:800}, {key:'hotel',label:'Hotel',estimate:520,actual:0,paidBy:'company',doc:'',variance:520}, {key:'meals',label:'Meals',estimate:280,actual:0,paidBy:'own',doc:'',variance:280}, {key:'local',label:'Local conveyance',estimate:200,actual:0,paidBy:'own',doc:'',variance:200}, {key:'visa',label:'Visa',estimate:185,actual:0,paidBy:'own',doc:'',variance:185}, {key:'baggage',label:'Baggage',estimate:0,actual:0,paidBy:'own',doc:'',variance:0}, {key:'misc',label:'Misc',estimate:0,actual:0,paidBy:'own',doc:'',variance:0}, {key:'custom-0',label:'Airport transfer / cab',estimate:0,actual:45,paidBy:'own',doc:'#doc',variance:-45,custom:true} ] } },
  { id: 'TRF-20260715-MINE4', type: 'domestic', trip: 'One-way', purpose: 'Training', route: 'Pune → Hyderabad', traveller: 'Finance Demo', raisedForOther: false,
    start: '15 Jul 2026', end: '', submission: '10 Jun 2026', stage: 'rejected', status: 'Rejected at Department Head',
    hod: 'Rejected', ceo: 'N/A', finance: 'N/A', booking: '', forexIssued: 'N/A',
    canEdit: false, canWithdraw: false,
    edit: {}, timeline: { steps: [ { label: 'Submitted', status: 'done', date: '10 Jun 2026' }, { label: 'HOD', status: 'rejected', date: '11 Jun 2026' } ], comments: [ '[Department Head · jatin · 11 Jun 2026] Rejected — can be done remotely.' ] } },
] };

// ---- mock master tracker (finance) ----
const FINANCE = {
  reconciliation: { available: true, fx: 92, linked: 1, estimateINR: 219880, actualINR: 195000, paidINR: 120000 },
  paymentMethods: { own: 27600, company: 156400, brex: 41400 },
  policyValues: [
    { path: 'POLICY.HOTEL.india.1', label: 'Hotel cap — India Tier 1 (₹/night)', group: 'Hotel caps', value: 6000 },
    { path: 'POLICY.HOTEL.india.2', label: 'Hotel cap — India Tier 2 (₹/night)', group: 'Hotel caps', value: 3000 },
    { path: 'POLICY.HOTEL.india.3', label: 'Hotel cap — India Tier 3 (₹/night)', group: 'Hotel caps', value: 2500 },
    { path: 'POLICY.HOTEL.us.1', label: 'Hotel cap — US Tier 1 ($/night)', group: 'Hotel caps', value: 175 },
    { path: 'POLICY.MEALS.domestic', label: 'Meals — India domestic (₹/day)', group: 'Meal per-diem', value: 800 },
    { path: 'POLICY.MEALS.overseas', label: 'Meals — overseas, no breakfast ($/day)', group: 'Meal per-diem', value: 70 },
    { path: 'POLICY.CAPS.TOTAL.international', label: 'Total cap — international ($)', group: 'Policy-break caps', value: 3000 },
    { path: 'CONFIG.FX.USD_INR', label: 'USD → INR rate', group: 'FX', value: 92 },
  ],
  policyChanges: [
    { ts: '2026-06-24T10:05:00Z', by: 'finance', path: 'POLICY.HOTEL.us.1', label: 'Hotel cap — US Tier 1 ($/night)', old: 150, new: 175 },
  ],
  currencySummaries: {
    INR: { count: 2, pending: 1, approved: 1, rejected: 0, totalPipeline: 58400, totalApproved: 29200 },
    USD: { count: 1, pending: 0, approved: 1, rejected: 0, totalPipeline: 2390, totalApproved: 2390 },
  },
  rows: [
    { id: 'TRF-20260901-AB12', name: 'Ved Prakash', dept: 'Technology', purpose: 'Client Meeting', pax: 3, passengers: ['Ved Prakash', 'Sanjay Kumar', 'Deepti Sharma'],
      start: '01 Sep 2026', end: '04 Sep 2026', submission: '17 Jun 2026', currency: 'USD', total: 2390, estimatedCost: 'USD 2,390', advForex: 650, advDeposit: 100, advance: 750,
      hodStatus: 'Approved', hodDate: '17 Jun 2026', ceoStatus: 'Approved', ceoDate: '17 Jun 2026', financeStatus: 'Approved', financeDate: '17 Jun 2026',
      bookingStatus: 'Completed', bookingDate: '18 Jun 2026', pnr: 'AI191 · PNR ABC123', ticketUploadDate: '18 Jun 2026',
      forexStatus: 'Issued', forexIssueDate: '19 Jun 2026', advanceStatus: '', advanceDate: '', expenseDate: '', closureDate: '',
      finalStatus: 'Completed — Forex card issued', type: 'international', route: 'Bengaluru → New York', trip: 'Round trip',
      flag: 'POLICY BREAK: Total USD 2,390 over threshold USD 3,000; Short notice — 9d (needs 30d)',
      breakdown: { transport: 800, mode: 'Flight (Economy)', local: 200, hotel: 520, hotelRate: 130, hotelNights: 4, meals: 280, mealRate: 70, other: 221, extras: { visa: 185, insurance: 20, phone: 16 }, forex: 500, deposit: 100, days: 4, nights: 4 },
      recon: { available: true, linked: 2, estimateINR: 219880, actualINR: 195000, paidINR: 120000, varianceINR: 24880, settlementINR: 55200, items: [ { id: 'EXP-101', item: 'Hotel — Marriott NYC', vendor: 'Marriott', category: 'Travel', amount: 1200, currency: 'USD', amountINR: 110400, status: 'Paid', paid: true }, { id: 'EXP-102', item: 'Airport cabs', vendor: 'Uber', category: 'Travel', amount: 920, currency: 'USD', amountINR: 84600, status: 'Pending Finance', paid: false } ] },
      canAddActuals: true,
      actuals: { status:'Submitted', currency:'USD', hasActuals:true, estTotal:2390, actualTotal:1700, variance:690, reimbursable:300, advance:725, reimburseApproved:0, items:[ {key:'flight',label:'Flight',estimate:800,actual:800,paidBy:'company',doc:'#',variance:0}, {key:'hotel',label:'Hotel',estimate:520,actual:600,paidBy:'company',doc:'#',variance:-80}, {key:'meals',label:'Meals',estimate:280,actual:200,paidBy:'own',doc:'#',variance:80}, {key:'local',label:'Local conveyance',estimate:200,actual:100,paidBy:'own',doc:'#',variance:100} ] } },
    { id: 'TRF-20260905-GH78', name: 'Rahul Mehta', dept: 'GTM Sales & Marketing', purpose: 'Partnership Meeting',
      start: '20 Sep 2026', end: '24 Sep 2026', submission: '17 Jun 2026', currency: 'INR', total: 29200, estimatedCost: 'INR 29,200',
      hodStatus: 'Approved', hodDate: '17 Jun 2026', ceoStatus: 'N/A', ceoDate: '', financeStatus: 'N/A', financeDate: '',
      bookingStatus: 'Pending', bookingDate: '', pnr: '', ticketUploadDate: '',
      forexStatus: 'N/A', forexIssueDate: '', advanceStatus: '', advanceDate: '', expenseDate: '', closureDate: '',
      finalStatus: 'Approved — With Admin for Arrangements', type: 'domestic', route: 'Mumbai → Delhi', trip: 'Round trip',
      flag: 'Within policy',
      breakdown: { transport: 9000, mode: 'Flight (Economy)', local: 5800, hotel: 12000, hotelRate: 6000, hotelNights: 2, meals: 2400, mealRate: 800, other: 0, forex: 0, days: 3, nights: 2 } },
    { id: 'TRF-20260903-EF56', name: 'Amit Walia', dept: 'Product', purpose: 'Site Visit',
      start: '08 Sep 2026', end: '08 Sep 2026', submission: '17 Jun 2026', currency: 'INR', total: 29200, estimatedCost: 'INR 29,200',
      hodStatus: 'Pending', hodDate: '', ceoStatus: 'N/A', ceoDate: '', financeStatus: 'N/A', financeDate: '',
      bookingStatus: 'Pending', bookingDate: '', pnr: '', ticketUploadDate: '',
      forexStatus: 'N/A', forexIssueDate: '', advanceStatus: '', advanceDate: '', expenseDate: '', closureDate: '',
      finalStatus: 'Pending HOD Approval', type: 'local', route: 'Bengaluru → Bengaluru', trip: 'One-way',
      flag: 'Within policy',
      breakdown: { transport: 3000, mode: 'Cab', local: 600, hotel: 0, hotelRate: 0, hotelNights: 0, meals: 800, mealRate: 800, other: 0, forex: 0, days: 1, nights: 0 } },
  ],
};

// ---- admin (awaiting booking) ----
const ADMIN = { rows: [
  { id: 'TRF-20260905-GH78', date: '17 Jun 2026', name: 'Rahul Mehta', email: 'rahul@spyne.ai', dept: 'GTM Sales & Marketing',
    type: 'domestic', trip: 'Round trip', route: 'Mumbai → Delhi  |  return Delhi → Mumbai', route2: 'Mumbai → Delhi', start: '20 Sep 2026', end: '24 Sep 2026',
    days: 3, nights: 2, mode: 'Flight (Economy)', currency: 'INR', hotelReq: 'Yes', hotelRate: 6000, hotelNights: 2,
    total: 29200, forex: 0, notes: 'Quarterly partner review', isForex: false, ticketInfo: '', docTicket: '', adminStatus: 'Pending', status: 'Approved — With Admin for Arrangements',
    flag: 'Within policy', breakdown: { transport: 9000, mode: 'Flight (Economy)', local: 5800, hotel: 12000, hotelRate: 6000, hotelNights: 2, meals: 2400, mealRate: 800, other: 0, forex: 0, days: 3, nights: 2 },
    flights: [ { label: 'Outbound', from: 'Mumbai', to: 'Delhi', date: '20 Sep 2026', time: '08:30', timeLabel: '08:30 IST' }, { label: 'Return', from: 'Delhi', to: 'Mumbai', date: '24 Sep 2026', time: '19:15', timeLabel: '19:15 IST' }, { label: 'Extra flight 1', from: 'Delhi', to: 'Jaipur', date: '22 Sep 2026', time: '11:00', timeLabel: '11:00 IST' } ],
    hotels: [ { label: 'Stay (destination)', city: 'Delhi', checkIn: '20 Sep 2026', checkOut: '22 Sep 2026', nights: 2 }, { label: 'Stay', city: 'Jaipur', checkIn: '22 Sep 2026', checkOut: '24 Sep 2026', nights: 2 } ],
    prefFlightDoc: '#doc', prefFlightNotes: 'Prefer morning non-stop, IndiGo',
    bookings: { flights: [], hotels: [] } },
  { id: 'TRF-20260907-IJ90', date: '17 Jun 2026', name: 'Sangeetha Swamy', email: 'sangeetha@spyne.ai', dept: 'HR, IT & Admin',
    type: 'international', trip: 'Round trip', route: 'Delhi → London  |  return London → Delhi', route2: 'Delhi → London', start: '25 Sep 2026', end: '29 Sep 2026',
    days: 5, nights: 4, mode: 'Flight (Economy)', currency: 'USD', hotelReq: 'Yes', hotelRate: 130, hotelNights: 4,
    total: 2110, forex: 625, notes: 'Global HR summit', isForex: true, ticketInfo: '', docTicket: '', adminStatus: 'Pending', status: 'Approved — With Admin for Arrangements',
    flag: 'POLICY BREAK: Short notice — 8d (needs 30d)', breakdown: { transport: 800, mode: 'Flight (Economy)', local: 240, hotel: 520, hotelRate: 130, hotelNights: 4, meals: 300, mealRate: 60, other: 0, forex: 625, days: 5, nights: 4 },
    flights: [ { label: 'Outbound', from: 'Delhi', to: 'London', date: '25 Sep 2026' }, { label: 'Return', from: 'London', to: 'Delhi', date: '29 Sep 2026' } ],
    hotels: [ { label: 'Stay (destination)', city: 'London', checkIn: '25 Sep 2026', checkOut: '29 Sep 2026', nights: 4 } ],
    bookings: { flights: [], hotels: [] } },
  { id: 'TRF-20260820-CMP1', date: '14 Jun 2026', name: 'Karan Mehra', email: 'karan@spyne.ai', dept: 'Customer Success',
    type: 'domestic', trip: 'Round trip', route: 'Pune → Hyderabad', route2: 'Pune → Hyderabad', start: '10 Aug 2026', end: '12 Aug 2026',
    days: 3, nights: 2, mode: 'Flight (Economy)', currency: 'INR', hotelReq: 'Yes', hotelRate: 3000, hotelNights: 2,
    total: 23800, forex: 0, notes: 'Completed booking (kept for Done tab)', isForex: false, ticketInfo: 'AI505, 10 Aug 2026, PNR PQR789', docTicket: '#doc', adminStatus: 'Completed', status: 'Completed',
    flag: 'Within policy', breakdown: { transport: 9000, mode: 'Flight (Economy)', local: 5800, hotel: 6000, hotelRate: 3000, hotelNights: 2, meals: 2400, mealRate: 800, other: 0, forex: 0, days: 3, nights: 2 },
    flights: [ { label: 'Outbound', from: 'Pune', to: 'Hyderabad', date: '10 Aug 2026' }, { label: 'Return', from: 'Hyderabad', to: 'Pune', date: '12 Aug 2026' } ],
    hotels: [ { label: 'Stay (destination)', city: 'Hyderabad', checkIn: '10 Aug 2026', checkOut: '12 Aug 2026', nights: 2 } ],
    bookings: { flights: [ { info: 'AI505 · PNR PQR789', doc: '#doc' }, { info: 'AI512 · PNR PQR790', doc: '#doc' } ], hotels: [ { info: 'Novotel HYD · CNF44521', doc: '#doc' } ] } },
] };

// ---- forex (booking done, awaiting card) ----
const FOREX = { rows: [
  { id: 'TRF-20260901-AB12', date: '17 Jun 2026', name: 'Ved Prakash', email: 'ved.gupta@spyne.ai', dept: 'Technology',
    to: 'New York', purpose: 'Client Meeting', start: '01 Sep 2026', days: 4, nationality: 'Indian', passportNo: 'P1234567',
    passportIssue: '12 Mar 2022, Delhi', designation: 'Engineering Manager', address: '12 MG Road, Bengaluru 560001', mobile: '+91 98765 43210',
    forex: 500, ticketInfo: 'AI191, 01 Sep 2026, PNR ABC123', docPassport: '#doc', docVisa: '#doc', docPanAadhaar: '',
    idDocType: 'Aadhaar & PAN (India)', docAadhaar: '#doc', docPan: '#doc', docNationalId: '', docTicket: '#doc',
    docForexConfirm: '', status: 'Booking done — Forex card (Jasvinder)',
    currency: 'USD', total: 2390, trip: 'Round trip', route: 'Bengaluru → New York',
    flag: 'POLICY BREAK: Short notice — 9d (needs 30d)', breakdown: { transport: 800, mode: 'Flight (Economy)', local: 290, hotel: 520, hotelRate: 130, hotelNights: 4, meals: 280, mealRate: 70, other: 305, extras: { visa: 185, insurance: 20, phone: 16, deposit: 100 }, forex: 500, days: 4, nights: 4 },
    done: false, forexBase: 500, topups: [], forexTotal: 500 },
  { id: 'TRF-20260805-DN44', date: '12 Jun 2026', name: 'Anita Rao', email: 'anita@spyne.ai', dept: 'Product',
    to: 'London', purpose: 'Conference / Event', start: '05 Aug 2026', days: 5, nationality: 'India', passportNo: 'P5566778',
    passportIssue: '20 Jul 2021, Mumbai', designation: 'Product Lead', address: '88 Linking Road, Mumbai 400050', mobile: '+91 91234 56789',
    forex: 625, ticketInfo: 'BA138, 05 Aug 2026, PNR XYZ987', docPassport: '#doc', docVisa: '#doc', docPanAadhaar: '',
    idDocType: 'Aadhaar & PAN (India)', docAadhaar: '#doc', docPan: '#doc', docNationalId: '', docTicket: '#doc',
    docForexConfirm: '#doc', status: 'Completed — Forex card issued',
    currency: 'USD', total: 2570, trip: 'Round trip', route: 'Mumbai → London',
    flag: 'Within policy', breakdown: { transport: 800, mode: 'Flight (Economy)', local: 290, hotel: 520, hotelRate: 130, hotelNights: 4, meals: 300, mealRate: 60, other: 225, extras: { insurance: 25, phone: 20, deposit: 100, visa: 0 }, forex: 625, days: 5, nights: 4 },
    done: true, forexIssueDate: '15 Jun 2026', forexBase: 625, topups: [ { amount: 150, note: 'Extended stay — 2 more nights', by: 'jasvinder', date: '16 Jun 2026' } ], forexTotal: 775 },
] };

// ---- app accounts (user management) ----
const USERS = { ok: true, users: [
  { email: 'finance.demo@spyne.ai', name: 'Finance Demo', created: '2026-06-01T10:00:00Z', lastLogin: '2026-06-24T08:30:00Z', status: 'Active', roles: ['finance'], pendingInvite: false },
  { email: 'ved.gupta@spyne.ai', name: 'Ved Prakash', created: '2026-06-10T09:00:00Z', lastLogin: '2026-06-23T17:10:00Z', status: 'Active', roles: ['requester'], pendingInvite: false },
  { email: 'jatin@spyne.ai', name: 'Jatin Jain', created: '2026-06-12T09:00:00Z', lastLogin: '2026-06-22T11:00:00Z', status: 'Active', roles: ['hod','requester'], pendingInvite: false },
  { email: 'newjoiner@spyne.ai', name: 'New Joiner', created: '2026-06-24T07:00:00Z', lastLogin: '', status: 'Active', roles: ['requester'], pendingInvite: true },
  { email: 'exleaver@spyne.ai', name: 'Ex Leaver', created: '2026-05-02T09:00:00Z', lastLogin: '2026-05-30T14:00:00Z', status: 'Disabled', roles: ['requester'], pendingInvite: false },
] };

const ROLES_VIEW = {
  assignments: {
    ceo: 'sanjay@spyne.ai',
    finance: ['accounts@spyne.ai', 'finance.head@spyne.ai'],
    admin: ['shankul.rastogi@spyne.ai'],
    forex: ['jasvinder@spyne.ai'],
    depts: { 'Finance & Account': 'priya@spyne.ai', 'HR, IT & Admin': 'jatin@spyne.ai', 'Engineering': 'arjun@spyne.ai', 'Sales': 'neha@spyne.ai' },
  },
  departments: ['Finance & Account', 'HR, IT & Admin', 'Engineering', 'Sales'],
};

function json(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const qs = (req.url.split('?')[1] || '');
  // Mock mutations (edit/withdraw/delegate/admin/forex actions) — just acknowledge.
  if (req.method === 'POST') {
    if (url === '/api/auth/login') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let b = {}; try { b = JSON.parse(body || '{}'); } catch {}
        const e = String(b.email || '').trim().toLowerCase();
        if (b.action === 'forgot') return json(res, { ok: true, message: 'If an account exists for that email, a reset link is on its way.' });
        if (b.action === 'reset') { if (b.password && b.password.length < 8) return json(res, { ok: false, error: 'Password must be at least 8 characters.' }); return json(res, { ok: true, next: b.next || '/' }); }
        if (e && !e.endsWith('@spyne.ai')) return json(res, { ok: false, error: 'Only @spyne.ai email addresses can sign up.' });
        if (b.action === 'register' && e === 'taken@spyne.ai') return json(res, { ok: false, error: 'An account with this email already exists — sign in instead.' });
        if (b.action === 'login' && b.password === 'wrong') return json(res, { ok: false, error: 'Incorrect email or password.' });
        return json(res, { ok: true, next: b.next || '/' });
      });
      return;
    }
    if (url === '/api/finance') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let b = {}; try { b = JSON.parse(body || '{}'); } catch {}
        const e = String(b.email || '').trim();
        if (b.action === 'user-invite') { if (e && !e.toLowerCase().endsWith('@spyne.ai')) return json(res, { ok: false, error: 'Only @spyne.ai email addresses are allowed.' }); return json(res, { ok: true, email: e, link: 'http://localhost:8731/reset.html?email=' + encodeURIComponent(e) + '&token=demotoken' }); }
        if (b.action === 'user-reset') return json(res, { ok: true, email: e, link: 'http://localhost:8731/reset.html?email=' + encodeURIComponent(e) + '&token=demotoken' });
        if (b.action === 'user-status') return json(res, { ok: true, email: e, status: b.active ? 'Active' : 'Disabled' });
        if (b.action === 'reminders') return json(res, { ok: true, remindersOn: typeof b.on !== 'undefined' ? !!b.on : true, reminderHour: typeof b.hour !== 'undefined' ? parseInt(b.hour, 10) : 9 });
        if (b.action === 'scrap') return json(res, { ok: true, scrapped: (b.ids || []).length, notFound: [] });
        if (b.action === 'role') { const v = String(b.value || '').split(',').map((s) => s.trim()).filter(Boolean); const a = ROLES_VIEW.assignments; if (b.key === 'ceo') a.ceo = v[0] || ''; else if (b.key === 'finance') a.finance = v; else if (b.key === 'admin') a.admin = v; else if (b.key === 'forex') a.forex = v; else if (String(b.key).indexOf('dept:') === 0) a.depts[String(b.key).slice(5)] = v[0] || ''; return json(res, { ok: true, key: b.key, assignments: a, departments: ROLES_VIEW.departments }); }
        return json(res, { ok: true, msg: 'mock ok', title: 'Done' });
      });
      return;
    }
    return json(res, { ok: true, msg: 'mock ok', title: 'Done' });
  }
  if (url === '/api/finance' && /view=users/.test(qs)) return json(res, USERS);
  if (url === '/api/finance' && /view=roles/.test(qs)) return json(res, { ok: true, ...ROLES_VIEW });
  if (url === '/api/me' && /counts/.test(qs)) return json(res, { approvals: 2, department: 1, finance: 1, admin: 1, forex: 0, items: [
    { key: 'TRF-20260918-PEN1:approval', id: 'TRF-20260918-PEN1', kind: 'approval', title: 'Approval needed — Department Head', href: '/hod', sub: 'Arjun Nair · Bengaluru → New York' },
    { key: 'TRF-20260915-PEN2:approval', id: 'TRF-20260915-PEN2', kind: 'approval', title: 'Approval needed — Department Head', href: '/hod', sub: 'Neha Singh · Delhi → Mumbai' },
    { key: 'TRF-20260901-AB12:reimburse', id: 'TRF-20260901-AB12', kind: 'reimburse', title: 'Reimbursement claim to approve', href: '/department', sub: 'Ved Prakash · Bengaluru → New York' },
    { key: 'TRF-20260801-MINE3:finance', id: 'TRF-20260801-MINE3', kind: 'finance', title: 'Reimbursement to settle', href: '/finance', sub: 'Finance Demo · Mumbai → London' },
    { key: 'TRF-20260905-GH78:admin', id: 'TRF-20260905-GH78', kind: 'admin', title: 'Booking to arrange', href: '/admin', sub: 'Rahul Mehta · Mumbai → Delhi' },
  ] });
  if (url === '/api/me' && /keka=/.test(qs)) {
    const em = decodeURIComponent((qs.match(/keka=([^&]+)/) || [, ''])[1]).toLowerCase();
    const dir = { 'finance.demo@spyne.ai': { name: 'Finance Demo', employeeId: 'SPN-1001' }, 'ved.gupta@spyne.ai': { name: 'Ved Prakash', employeeId: 'SPN-1042' }, 'ravi@spyne.ai': { name: 'Ravi Kumar', employeeId: 'SPN-1088' } };
    const hit = dir[em];
    return json(res, hit ? { available: true, ok: true, name: hit.name, employeeId: hit.employeeId, email: em } : { available: true, ok: false, error: 'No employee found for that email.' });
  }
  if (url === '/api/me' && /flights=/.test(qs)) {
    const cur = /cur=USD/.test(qs) ? 'USD' : 'INR';
    const intl = /intl=1/.test(qs);
    const mk = (kind, price, dur, stops, carrier, dep, arr) => ({ kind, price, durationMin: dur, stops, carrier, depart: dep, arrive: arr });
    const base = cur === 'USD' ? 700 : 5200;
    const options = [ mk('Cheapest', base, 155, 0, 'IndiGo', '2026-09-30T06:10:00', '2026-09-30T08:45:00'), mk('Fastest', Math.round(base * 1.3), 140, 0, 'Air India', '2026-09-30T09:20:00', '2026-09-30T11:40:00') ];
    if (intl) options.push(mk('Non-stop', Math.round(base * 1.15), 600, 0, 'Lufthansa', '2026-09-30T01:30:00', '2026-09-30T07:15:00'));
    const more = [ mk('', Math.round(base * 1.05), 210, 1, 'Vistara', '2026-09-30T13:00:00', '2026-09-30T16:30:00'), mk('', Math.round(base * 1.2), 320, 1, 'SpiceJet', '2026-09-30T19:45:00', '2026-09-30T01:05:00') ];
    return json(res, { ok: true, configured: true, currency: cur, count: 4, options, more });
  }
  if (url === '/api/me') return json(res, /mine/.test(qs) ? MINE : ME);
  if (url === '/api/config') return json(res, CONFIG_RES);
  if (url === '/api/finance') return json(res, FINANCE);
  if (url === '/api/admin') return json(res, ADMIN);
  if (url === '/api/forex') return json(res, FOREX);
  if (url === '/api/decision' && /view=(hod|approvals)/.test(qs)) return json(res, APPROVALS);
  let f = url === '/' ? (process.env.PREVIEW_PAGE || '/index.html') : url;
  if (f === '/finance') f = '/finance.html';
  if (f === '/admin') f = '/admin.html';
  if (f === '/forex') f = '/forex.html';
  if (f === '/hod') f = '/hod.html';
  if (f === '/department') f = '/department.html';
  if (f === '/my') f = '/my.html';
  if (!path.extname(f)) f += '.html';
  try {
    const data = readFileSync(path.join(root, f));
    const ext = path.extname(f);
    const ct = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : ext === '.svg' ? 'image/svg+xml' : 'text/plain';
    res.writeHead(200, { 'Content-Type': ct }); res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(8731, () => console.log('mock server on 8731'));
