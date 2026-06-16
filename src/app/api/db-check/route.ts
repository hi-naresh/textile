import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET() {
  try {
    const timeRes = await query('SELECT NOW() as now');
    
    // Check table counts to verify they exist
    const tables = [
      'users',
      'workers',
      'lots',
      'capture_events',
      'stock_movements',
      'job_cards',
      'allotments',
      'efficiency_daily',
      'cctv_activity',
      'chat_audit'
    ];
    
    const tableStatuses: { [key: string]: boolean | number } = {};
    
    for (const table of tables) {
      try {
        const countRes = await query(`SELECT COUNT(*) as count FROM ${table}`);
        tableStatuses[table] = parseInt(countRes.rows[0].count, 10);
      } catch (err) {
        tableStatuses[table] = false;
      }
    }
    
    return NextResponse.json({
      status: 'ok',
      dbTime: timeRes.rows[0].now,
      tables: tableStatuses
    });
  } catch (error) {
    console.error('Database check failed:', error);
    return NextResponse.json(
      { status: 'error', message: String(error) },
      { status: 500 }
    );
  }
}
