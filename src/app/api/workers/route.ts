import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET() {
  try {
    // 1. Fetch workers
    const workersRes = await query(`SELECT * FROM workers WHERE active = true ORDER BY name ASC`);
    
    // 2. Fetch daily efficiency for the last 7 days
    const efficiencyRes = await query(`
      SELECT ed.*, w.name, w.section
      FROM efficiency_daily ed
      JOIN workers w ON ed.worker_id = w.id
      ORDER BY ed.date DESC, ed.efficiency_pct ASC
    `);

    // 3. Fetch recent CCTV tracking activity
    const cctvRes = await query(`
      SELECT c.*, w.name
      FROM cctv_activity c
      JOIN workers w ON c.worker_id = w.id
      ORDER BY c.ts DESC
      LIMIT 50
    `);

    return NextResponse.json({
      workers: workersRes.rows,
      efficiency: efficiencyRes.rows.map(row => ({
        ...row,
        allotted: parseFloat(row.allotted),
        done: parseFloat(row.done),
        efficiency_pct: parseFloat(row.efficiency_pct)
      })),
      cctv: cctvRes.rows.map(row => ({
        ...row,
        active_pct: parseFloat(row.active_pct),
        idle_min: parseFloat(row.idle_min)
      }))
    });
  } catch (error) {
    console.error('Failed to fetch workers data:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
