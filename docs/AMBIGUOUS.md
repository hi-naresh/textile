# Open questions about the firm's registers

Questions from importing the firm's two Excel registers into the app: the **Incoming register** ("INCOMING- LAN STOCK", one row per lot received) and the **Outgoing register** ("OUTGOING-sale -19-8", one row per lot on a bill). Each section covers:

- **We see**: what is in the files, with examples.
- **App now**: what the app does today (our guess, which we can change easily).
- **Question**: what we need the owner to tell us.

The app stores the unclear columns exactly as written. They are not used to work out stock. The only exception is STOCK in the Incoming register, which sets each lot's starting balance.

---

## 1. LOT S codes in the Outgoing register (R / E / S / A)

**We see**
- 57 rows. Codes: R 22 times, E 16, S 12, A 4, blank once (bill 2191, lot 3736).
- When one SR.NO has several rows, sorted by bill number, the order is always **S → R → … → E**:
  - SR 551: S (bill 2183), R (2195), R (2205)
  - SR 563: S (2190), then E (2193)
  - SR 501: S (2197), then R (2199). SR 509: S (2202), then R (2212)
  - SR 186: R (2201), then E (2204). SR 434: R (2182), then E (2198). Here the S was probably on an earlier day.
  - Lot 8946: S on bill 2186 (no SR.NO), then R on bills 2187 and 2197 (SR 502).
- E never comes before another sale of the same lot. On the Incoming register, "E" in STOCK means the lot is finished.
- A appears 4 times, each time as the only row for its SR (SR 452: 5,296 m; 488: 1,079.75 m; 552: 6,428.25 m; 571: 804 m). These are big amounts, as if the whole lot went at once.

**Our best guess**
- **S** = Start: the first sale from the lot, with more left.
- **R** = Running: a later sale, with more still left.
- **E** = End: the last sale, and the lot is now finished.
- **A** = All: the whole lot sold in one bill.

**App now**
- The code is saved with each sale and shown on the ledger row.
- On hover, a tooltip shows the guess, marked "our guess".
- The code is data only. It never changes a balance.
- Any code other than R / E / S / A is kept, with a note.

**Question**
- Is the guess right?
- Should the app use these codes? For example, warn when a sale marked E leaves stock in the lot, or when A is not the full lot.

## 2. "L" in the Outgoing register

**We see**
- Values seen: 97, 98, 100, 104, 105, 108, 110, 112.5 and 115. 100 is the most common (23 rows).
- On every row, NQTY = QTY × L ÷ 100 (it is a formula, e.g. `=G3*D3/100`). Example: 3,102 m with L 110 gives NQTY 3,412.2.
- L belongs to the bill, not to the quality. NAZNEEN is sold at 100, 104, 108 and 110. Bill 2212 has two rows with different L (100 and 115).

**App now**
- L is saved as "L" and NQTY as "billed meters".
- QTY (not NQTY) comes out of the lot's stock.
- Both are shown on the row and in the Excel export.

**Question**
- What does L mean? Is it a billing percentage agreed with the buyer (above 100 = extra for shrinkage or folding, below 100 = a cut)?
- Which number is the real meters that left the godown: QTY or NQTY?

## 3. "%" in the Incoming register

**We see**
- Values run from 2.69 to 15.81.
- The value always sits inside the % range in the ITEM name:
  - "SOFIYA - 5 % - 10 %": 9.33 to 10.11
  - "SOFIYA - 10 % + 15 %": 14.03 to 14.68
  - "SEMI NAZNEEN 13%+": 13.61 to 15.81
  - "SOFIYA - 0 % + 5 %": 2.69 and 3.91
  - CHINON: 4.85 and 6.01

**App now**
- Saved as "%" on the incoming entry and shown as "9.55%". Not used anywhere else.

**Question**
- What is it: shrinkage or loss in processing, a weight percentage, or something else?
- Should it work out grey → finished meters? (Today the app treats MTR as plain stock meters. See §9.)

## 4. LOCATION codes in the Incoming register

**We see**
- The heading is spelled "LOCTION".
- Values look like 212, 206, 144, "142+143", "145+144", "140+41", "153+152", "172+173" and "56+57+l" (with a small letter L at the end).
- Two lots share 206 (SR 4 and SR 5).

**App now**
- The code is saved exactly as written, on the incoming entry and on the lot.
- It shows as "Loc 212" on the ledger row and "Loc code 212" in Lots & balance.
- The ledger search finds it.
- The app's own location is separate. Since the owner's change (October 2026) it is always a market location: market initials + shop no. + pipe no., like "LM 245 · Pipe 3" (Landmark, shop 245, pipe 3). Godown, Shop and Floor are no longer offered.
- Imported lots get no app location ("Not recorded") until someone moves them, or "Dispatched" when STOCK is E.

**Question**
- What are these numbers: shop numbers, rack or pipe numbers, or godown bays?
- Which market are they in: Landmark (LM), Raghuveer Scarlet (RS), or another one?
- Does "142+143" mean the lot is split over two places (two shops, or two pipes)?
- What is the "l" in "56+57+l"?
- Should the import turn the codes into market locations (for example "LM 212"), and if so, how do we know the market and the pipe?

## 5. MILL codes (L, D, H, D42")

**We see**
- Mill is a short code: L (18 lots), D (1), D42" (1), H (2).
- D42" looks like mill D plus a width of 42 inches.
- The H lots are the CHINON "- W" items.

**App now**
- The code is saved as the mill name ("L", "D42\"") and shows where the mill name normally goes.

**Question**
- What are the full mill names?
- Is the 42" a width, and should it be kept separately?

## 6. Two lots in one row ("172+173", SR.NO "146+204")

**We see**
- Bills 2204, 2206, 2207 and 2209 have LOT "172+173" (or "173+172") and SR.NO "146+204".
- Interesting: in the Incoming register, "172+173" is a LOCATION code (SR 22, lot 22896).
- The Outgoing register also has LOT values that are not numbers: "FP-K-12", "CH-130", "GR-31", "179A".

**App now**
- These rows are skipped with a warning ("Two lots in one row … split it into one row per lot").
- Skipped rows are in the "Rows to fix" Excel.
- A "+" in the Incoming register's LOT NO is skipped the same way.

**Question**
- How were the meters split between the two lots? Can the register use one row per lot?
- In these rows, is "172+173" a lot number or a location?

## 7. Empty bill rows

**We see**
- Bills 2189 and 2211 have only DATE and BNO, with nothing else.
- Bill numbers 2182–2215 are all used, so these look like cancelled or spoilt bills kept to keep the numbering.

**App now**
- Skipped with a warning ("empty bill row").

**Question**
- Are these cancelled bills? Should the app record them as cancelled?

## 8. Lot numbers repeat (the lot key)

**We see**
- LOT NO is the mill's number. It is short for some mills (34, 33, 162, 273, 627, 927) and long for others (23133).
- Different mills can use the same number.
- SRNO is the register's own serial and should never repeat.

**App now (decision)**
- The incoming SRNO is the real identity. Sales find their lot by SR.NO.
- The app's lot number is the register's LOT NO when it is free.
- If that number is already used by another lot, the new lot is saved as **"<LOT NO>-SR<SRNO>"** (e.g. "34-SR16"), with a note. The register's number is kept too ("Register lot no. 34").
- A sale without an SR.NO is matched by lot number only when exactly one lot has that number. Otherwise it is skipped.

**Question**
- Is SRNO one continuous series for the whole firm, or does it restart (each year, each register, each mill)?
- The sales file points at SR 102–571, but the incoming file has SR 1–23. Are these different register books?

## 9. MTR: grey or finished meters?

**We see**
- MTR can have decimals (7,643.5).
- The register has no separate grey and finished columns.

**App now**
- MTR is recorded as the lot's stock meters, with grey and finished left blank.

**Question**
- Is MTR grey (from the weaver/mill) or finished meters? Does "%" (see §3) turn one into the other?

## 10. S-1 … S-10 add up to more than MTR

**We see**
- In 15 of the 16 finished lots (STOCK = E), S-1…S-10 add up to 1–6 % **more** than MTR. Examples:
  - SR 1: MTR 7,933, S-1 8,314.11 (+4.8 %)
  - SR 5: MTR 7,723, S total 8,162.66 (+5.7 %)
- One finished lot has less: SR 6 has 7,122.49 of 7,186, so 63.51 m is not accounted for.
- Lots that are not finished match: STOCK = MTR − S total.

**App now**
- The starting balance always comes from STOCK (E = 0).
- The difference MTR − STOCK is saved as one "Opening adjustment (register)" OUT, dated the lot's DATE.
- S-1…S-10 are kept on the incoming entry, for the record.
- If STOCK is a number but MTR − S total gives a different answer, STOCK wins and a warning is shown.
- The extra meters out are mentioned in a note but not recorded.

**Question**
- Why do sales exceed MTR? Is it stretch or gain in finishing? Or are the S values billed meters (NQTY, with L above 100)?
- Should the app record the extra meters?

## 11. Is a sale counted twice? (Incoming S-1…S-10 vs the Outgoing register)

**We see**
- The S-n columns look like the sales of each lot, which are probably the same sales as in the Outgoing register.
- The two sample files share no SR or lot, so we cannot check.

**App now**
- Importing the Incoming register sets each lot to its STOCK.
- Importing the Outgoing register then takes each sale out again.
- If both files cover the same sales, those sales are taken out twice. When the lot has too little stock, the sale is skipped ("not enough stock").

**Question**
- Do you fill S-1…S-10 from the sales register? If yes, we suggest:
  1. Import the Incoming register once, as of a cut-off date.
  2. From then on, import only sales after that date.
- Or should the app skip outgoing rows dated before the incoming import?

## 12. Dates in the future

**We see**
- SR 9 is dated 19-11-2026 and SR 12 is dated 25-12-2026. The file was checked on 7-10-2026, and the rows around them are January–May 2026.
- They are probably 19-11-2025 and 25-12-2025, typed with the wrong year.
- The sales file is named "sale -19-8", but every row is dated 17-08-2026.

**App now**
- Saved as written, with a warning on the row ("Date … is in the future — check it").
- Register rows have only a date, so the ledger shows 00:00 as the time.

**Question**
- Are these typing mistakes? Should the app refuse future dates instead of warning?
- Which date does the sales register use?

## 13. No party in the Outgoing register

**We see**
- There is no party (buyer) column, only the bill number.

**App now**
- Imported sales have no party, and the ledger shows "→ no party".
- The Dispatch agent's order matching and the party reports don't see these sales.

**Question**
- Can a party column be added, or can the app get the party from the bill number (for example from Tally)?

## 14. Quality names differ between the registers

**We see**
- The Incoming ITEM includes the % band ("SOFIYA - 5 % - 10 %").
- The Outgoing ITEM is shorter ("SOFIYA", "NAZNEEN 4KG").

**App now**
- A lot's quality is the Incoming ITEM.
- When a sale's ITEM differs, the sale is still saved on the lot (found by SR.NO), with a warning.

**Question**
- Should "SOFIYA" count as the same quality as "SOFIYA - 5 % - 10 %"? Is there a master list of qualities?

## 15. Smaller points

- **Design:** the registers have no design, so imported lots get the design "No design".
- **Opening adjustment date:** the adjustment is dated the lot's incoming DATE.
  - It is left out of the "dispatched" figures (today's out, the flow chart, demand by quality), because it is not a sale.
  - Question: should it be dated the import day instead?
- **Re-importing an updated Incoming register:** a lot already imported is not changed. A note says when the file's STOCK now differs from the app.
  - Question: should a newer register correct the app's balance?
