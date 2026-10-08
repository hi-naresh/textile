'use client';

// The one place a person picks a lot location: market → shop no. → pipe no. → "LM 245 · Pipe 3".
// Used by manual entry (arrival), moving a lot and confirming an incoming photo read.
//   Market   buttons "LM · Landmark" (active markets); the owner can add a market here (name + initials).
//   Shop no. type or pick from the market's shops (most used first); a new number is added to the market
//            (owner / supervisor) with the button, or when the entry is saved.
//   Pipe no. optional, typed by hand: a whole number 1–999.
// Emits the label when it is complete and valid, '' otherwise (+ whether the picker is finished). Remount (key) to reset it.
// "Floor" and "Dispatched" are never offered: the app sets them (job cards, dispatch).
import React, { useId, useMemo, useState } from 'react';
import Icon from './Icon';
import { Pill } from './ui';
import type { Ctx } from './ctx';
import { activeMarkets, canAddShops, canManageMarkets, markets as allMarkets } from '@/lib/access';
import { checkCode, checkMarketName, checkPipe, checkShop, describeLocation, describePlace, formatMarketLocation, parseMarketLocation } from '@/lib/location';
import { locationTone } from '@/lib/derive';

const QUICK_SHOPS = 6;

export function MarketLocationPicker({ ctx, value, onChange, exclude, optional = false }: {
  /** `done` is false while a market is picked but the shop / pipe is not finished (optional mode: "Not now" is done). */
  ctx: Ctx; value: string; onChange: (v: string, done: boolean) => void; exclude?: string | null; optional?: boolean;
}) {
  const { d, role } = ctx;
  const id = useId();
  const list = activeMarkets();
  const start = value ? parseMarketLocation(value, list) : null;
  const startPlace = start && start.ok ? start.place : null;
  const [marketId, setMarketId] = useState<number | null>(startPlace?.market.id ?? (optional ? null : list[0]?.id ?? null));
  const [shop, setShop] = useState(startPlace?.shop ?? '');
  const [pipe, setPipe] = useState(startPlace?.pipe != null ? String(startPlace.pipe) : '');
  const [shopTouched, setShopTouched] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busyShop, setBusyShop] = useState(false);
  const market = list.find((m) => m.id === marketId) ?? null;

  const shopCheck = checkShop(shop);
  const pipeCheck = checkPipe(pipe);
  const shops = useMemo(() => (market?.shops ?? []).filter((s) => s.active), [market]);
  const known = shopCheck.ok && shops.some((s) => s.shop_no === shopCheck.value);
  const label = market && shopCheck.ok && pipeCheck.ok ? formatMarketLocation(market.code, shopCheck.value, pipeCheck.value) : '';
  const same = !!label && label === exclude;

  const emit = (mId: number | null, s: string, p: string) => {
    const m = list.find((x) => x.id === mId);
    const sc = checkShop(s);
    const pc = checkPipe(p);
    const label = m && sc.ok && pc.ok ? formatMarketLocation(m.code, sc.value, pc.value) : '';
    onChange(label, !m || !!label);
  };
  const pickMarket = (mId: number | null) => { setMarketId(mId); emit(mId, shop, pipe); };
  const typeShop = (v: string) => { setShop(v); emit(marketId, v, pipe); };
  const typePipe = (v: string) => { setPipe(v); emit(marketId, shop, v); };

  const addShopNow = async () => {
    if (!market || !shopCheck.ok) return;
    setBusyShop(true);
    const r = await d.marketsApi.addShop(market.id, shopCheck.value, market.name);
    setBusyShop(false);
    if (!r.ok) d.showToast(r.error, 'danger');
  };

  const shopErr = shop.trim() && !shopCheck.ok ? shopCheck.error : null;
  const pipeErr = !pipeCheck.ok ? pipeCheck.error : null;
  const mayAddShop = canAddShops(role);

  return (
    <div className="mlp">
      <div role="group" aria-label="Market" className="mlp-markets">
        {optional && (
          <button type="button" className={`opt ${marketId == null ? 'on' : ''}`} aria-pressed={marketId == null} onClick={() => pickMarket(null)}>
            Not now<span className="opt-sub">set it later</span>
          </button>
        )}
        {list.map((m) => (
          <button key={m.id} type="button" className={`opt ${m.id === marketId ? 'on' : ''}`} aria-pressed={m.id === marketId} onClick={() => pickMarket(m.id)} title={m.name}>
            <span className="mlp-code">{m.code}</span><span className="opt-sub mlp-name">{m.name}</span>
          </button>
        ))}
        {canManageMarkets(role) && !adding && (
          <button type="button" className="opt mlp-addbtn" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} strokeWidth={2} /><span className="opt-sub">Add market</span>
          </button>
        )}
      </div>
      {!list.length && <span className="muted small">No markets yet.{canManageMarkets(role) ? ' Add one above.' : ' The owner adds them in My firm → Markets & locations.'}</span>}
      {adding && <AddMarketForm ctx={ctx} onDone={(newId) => { setAdding(false); if (newId != null) pickMarket(newId); }} />}

      {market && (
        <div className="mlp-fields">
          <label className="fld">Shop no. in {market.name}
            <input className="num" list={`${id}-shops`} value={shop} autoComplete="off" autoCapitalize="characters" placeholder={shops[0]?.shop_no ? `e.g. ${shops[0].shop_no}` : 'e.g. 245'}
              aria-invalid={!!shopErr || (shopTouched && !shop.trim() && !optional)} aria-describedby={`${id}-shop-msg`}
              onChange={(e) => typeShop(e.target.value)} onBlur={() => setShopTouched(true)} maxLength={10} />
            <datalist id={`${id}-shops`}>{shops.map((s) => <option key={s.id} value={s.shop_no}>{s.uses ? `${s.uses} moves` : 'new'}</option>)}</datalist>
          </label>
          <label className="fld">Pipe no.
            <input className="num" inputMode="numeric" value={pipe} autoComplete="off" placeholder="optional" maxLength={5}
              aria-invalid={!!pipeErr} aria-describedby={`${id}-pipe-msg`} onChange={(e) => typePipe(e.target.value)} />
          </label>
          {shops.length > 0 && (
            <div className="mlp-quick" role="group" aria-label={`Shops in ${market.name}, most used first`}>
              {shops.slice(0, QUICK_SHOPS).map((s) => (
                <button key={s.id} type="button" className={`chip ${shopCheck.ok && shopCheck.value === s.shop_no ? 'on' : ''}`} aria-pressed={shopCheck.ok && shopCheck.value === s.shop_no} onClick={() => typeShop(s.shop_no)}>{s.shop_no}</button>
              ))}
              {shops.length > QUICK_SHOPS && <span className="muted tiny">+{shops.length - QUICK_SHOPS} more — type to find</span>}
            </div>
          )}
          <div className="mlp-msg" aria-live="polite">
            {shopErr && <span id={`${id}-shop-msg`} className="err small">{shopErr}</span>}
            {pipeErr && <span id={`${id}-pipe-msg`} className="err small">{pipeErr}</span>}
            {!shopErr && shopTouched && !shop.trim() && !optional && <span className="err small">Type the shop no.</span>}
            {shopCheck.ok && !known && (mayAddShop ? (
              <span className="mlp-new small">
                Shop {shopCheck.value} is new in {market.name}.
                <button type="button" className="btn sm" disabled={busyShop} onClick={addShopNow}><Icon name="plus" size={14} strokeWidth={2} />Add shop {shopCheck.value} to {market.name}</button>
              </span>
            ) : <span className="err small">Shop {shopCheck.value} is not in {market.name}&apos;s list. Ask the owner or a supervisor to add it.</span>)}
          </div>
          <span className={`loc-preview small ${same ? 'bad' : ''}`}>
            {!label ? (shop.trim() ? '' : 'Type or pick the shop no.')
              : same ? `Already at ${label}.`
              : <>Saved as <span className="strong">{label}</span> — {describePlace(market.name, shopCheck.ok ? shopCheck.value : '', pipeCheck.ok ? pipeCheck.value : null)}</>}
          </span>
        </div>
      )}
    </div>
  );
}

/** Owner: name + initials, checked against the list as you type. Not a <form> (it sits inside other forms). */
function AddMarketForm({ ctx, onDone }: { ctx: Ctx; onDone: (newId: number | null) => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const all = allMarkets();
  const n = checkMarketName(name);
  const c = checkCode(code);
  const nameTaken = n.ok && all.find((m) => m.name.toLowerCase() === n.value.toLowerCase());
  const codeTaken = c.ok && all.find((m) => m.code === c.value);
  const err = name.trim() && !n.ok ? n.error
    : nameTaken ? `${nameTaken.name} is already in the list.`
    : code.trim() && !c.ok ? c.error
    : codeTaken ? `${codeTaken.code} is already used by ${codeTaken.name}.` : null;
  const ready = n.ok && c.ok && !nameTaken && !codeTaken;
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setServerErr(null);
    const r = await ctx.d.marketsApi.addMarket(n.value, c.value);
    setBusy(false);
    if (!r.ok) { setServerErr(r.error); return; }
    const m = r.data.market as { id?: number } | undefined;
    onDone(m?.id ?? null);
  };
  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') onDone(null); };
  return (
    <div className="mlp-addform" role="group" aria-label="Add a market">
      <label className="fld">Market name<input value={name} maxLength={60} onChange={(e) => { setName(e.target.value); setServerErr(null); }} onKeyDown={enter} placeholder="e.g. Landmark 2" autoFocus /></label>
      <label className="fld">Initials<input className="num" value={code} maxLength={6} autoCapitalize="characters" onChange={(e) => { setCode(e.target.value.toUpperCase()); setServerErr(null); }} onKeyDown={enter} placeholder="e.g. LM2" /></label>
      <div className="row-8 mlp-addactions">
        <button type="button" className="btn sm primary" disabled={!ready || busy} onClick={save}>Add market</button>
        <button type="button" className="btn sm" onClick={() => onDone(null)}>Cancel</button>
      </div>
      {(err || serverErr) && <span className="err small mlp-adderr">{serverErr ?? err}</span>}
      {!err && !serverErr && <span className="muted tiny mlp-adderr">Initials are the short form on labels, like {c.ok ? c.value : 'LM'} 245 · Pipe 3.</span>}
    </div>
  );
}

/** A location label as a pill, with the full market name on hover ("Landmark, shop 245, pipe 3"). */
export function LocationPill({ location, className, empty = 'Not recorded' }: { location: string | null | undefined; className?: string; empty?: string }) {
  const full = describeLocation(location, allMarkets());
  return <Pill tone={locationTone(location ?? null)} className={className} title={full ?? undefined}>{location ?? empty}</Pill>;
}
