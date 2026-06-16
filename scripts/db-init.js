const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Connection string to the default 'postgres' database
const defaultConnectionString = 'postgresql://naresh@localhost:5432/postgres';
const targetDbName = 'textile_db';
const targetConnectionString = `postgresql://naresh@localhost:5432/${targetDbName}`;

async function main() {
  console.log('Starting database initialization...');

  // Step 1: Connect to default postgres database to create target database
  const client = new Client({ connectionString: defaultConnectionString });
  await client.connect();

  try {
    // Check if database exists
    const dbCheckRes = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [targetDbName]
    );

    if (dbCheckRes.rowCount === 0) {
      console.log(`Database '${targetDbName}' does not exist. Creating it...`);
      // CREATE DATABASE cannot be executed inside a transaction block
      await client.query(`CREATE DATABASE ${targetDbName}`);
      console.log(`Database '${targetDbName}' created successfully.`);
    } else {
      console.log(`Database '${targetDbName}' already exists.`);
    }
  } catch (err) {
    console.error('Error checking/creating database:', err);
    process.exit(1);
  } finally {
    await client.end();
  }

  // Step 2: Connect to the target database and execute the schema.sql
  const targetClient = new Client({ connectionString: targetConnectionString });
  await targetClient.connect();

  try {
    console.log('Executing schema.sql...');
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    
    // Execute DDL statements
    await targetClient.query(schemaSql);
    console.log('Schema executed successfully. Tables created.');

    // Step 3: Seed initial data
    console.log('Seeding initial data...');

    // Seed Users
    const seedUsers = [
      ['usr-owner', 'Naresh Kumar', 'owner', 'en', true],
      ['usr-sup1', 'Sanjay Patel', 'supervisor', 'hi', true],
      ['usr-sup2', 'Kishore Gajiwala', 'supervisor', 'gu', true],
      ['usr-worker', 'Ramesh Floor', 'worker', 'hi', true]
    ];
    for (const user of seedUsers) {
      await targetClient.query(
        `INSERT INTO users (id, name, role, locale, active) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        user
      );
    }
    console.log('Users seeded.');

    // Seed Workers
    const seedWorkers = [
      ['wrk-01', 'Arvind Makwana', 'Weaving Section', 'operator', true],
      ['wrk-02', 'Mahesh Solanki', 'Dyeing Section', 'operator', true],
      ['wrk-03', 'Vijay Rathod', 'Printing Section', 'operator', true],
      ['wrk-04', 'Dinesh Vaghela', 'Folding Section', 'operator', true],
      ['wrk-05', 'Bharat Gohil', 'Folding Section', 'operator', true]
    ];
    for (const worker of seedWorkers) {
      await targetClient.query(
        `INSERT INTO workers (id, name, section, role, active) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        worker
      );
    }
    console.log('Workers seeded.');

    // Seed Lots
    const seedLots = [
      ['LOT-5021', 'Poly-Crepe Super', 'Design-104A', 'A', 'active'],
      ['LOT-5022', 'Georgette Silk Premium', 'Design-208C', 'A', 'active'],
      ['LOT-5023', 'Cotton Khadi Textured', 'Design-401', 'B', 'active'],
      ['LOT-5024', 'Linen Blend Classic', 'Design-302B', 'A', 'hold'],
      ['LOT-5025', 'Satin Smooth Satin', 'Design-512', 'A', 'completed']
    ];
    for (const lot of seedLots) {
      await targetClient.query(
        `INSERT INTO lots (lot_id, quality, design, grade, status) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (lot_id) DO NOTHING`,
        lot
      );
    }
    console.log('Lots seeded.');

    // Seed Capture Events (for the supervisor confirm queue)
    // One pending photo-capture event that was a low-confidence read on stock IN
    const seedCaptureEvents = [
      {
        photo_url: '/uploads/mock_challan_pending.jpg',
        type: 'incoming_stock',
        ai_json: {
          lot_id: 'LOT-5026',
          quality: 'Poly-Crepe Super',
          design: 'Design-104A',
          meters: 850.50,
          party: 'Surat Textiles Ltd',
          source_doc: 'CH-8821'
        },
        confidence: 0.65,
        status: 'pending'
      },
      {
        photo_url: '/uploads/mock_folding_pending.jpg',
        type: 'job_card_folding',
        ai_json: {
          job_card_id: 1, // Will link to the first job card
          lot_id: 'LOT-5021',
          meters_out: 492.00,
          worker_id: 'wrk-04'
        },
        confidence: 0.58,
        status: 'pending'
      }
    ];

    for (const ev of seedCaptureEvents) {
      await targetClient.query(
        `INSERT INTO capture_events (photo_url, type, ai_json, confidence, status) 
         VALUES ($1, $2, $3, $4, $5)`,
        [ev.photo_url, ev.type, JSON.stringify(ev.ai_json), ev.confidence, ev.status]
      );
    }
    console.log('Capture events seeded.');

    // Seed Stock Movements (IN)
    const seedMovements = [
      ['LOT-5021', 'IN', 500.00, 'Karan Fabrics', 'CH-4029'],
      ['LOT-5022', 'IN', 1200.00, 'Vimal Processors', 'CH-3011'],
      ['LOT-5023', 'IN', 750.00, 'Navsari Weaves', 'CH-2911'],
      ['LOT-5024', 'IN', 600.00, 'Surat Cottons', 'CH-9912'],
      ['LOT-5025', 'IN', 1000.00, 'Radhe Synthetics', 'CH-1180'],
      // Seed a completed cycle where 1000 went in, and 980 was dispatched (OUT)
      ['LOT-5025', 'OUT', 980.00, 'Mumbai Retailers', 'DISP-552']
    ];
    for (const mv of seedMovements) {
      await targetClient.query(
        `INSERT INTO stock_movements (lot_id, direction, meters, party, source_doc_id)
         VALUES ($1, $2, $3, $4, $5)`,
        mv
      );
    }
    console.log('Stock movements seeded.');

    // Seed Job Cards
    // Job card 1 is for LOT-5021, weaving stage, assigned to wrk-01 (Arvind). It is in folding stage.
    // Job card 2 is for LOT-5022, dyeing, completed.
    // Job card 3 is for LOT-5023, printing, in-process.
    await targetClient.query(
      `INSERT INTO job_cards (lot_id, process, worker_id, meters_in, meters_out, status, ts_closed)
       VALUES ('LOT-5021', 'Weaving', 'wrk-01', 500.00, NULL, 'in-process', NULL)`
    );
    await targetClient.query(
      `INSERT INTO job_cards (lot_id, process, worker_id, meters_in, meters_out, status, ts_closed)
       VALUES ('LOT-5022', 'Dyeing', 'wrk-02', 1200.00, 1188.00, 'closed', NOW())`
    );
    await targetClient.query(
      `INSERT INTO job_cards (lot_id, process, worker_id, meters_in, meters_out, status, ts_closed)
       VALUES ('LOT-5023', 'Printing', 'wrk-03', 750.00, NULL, 'open', NULL)`
    );
    console.log('Job cards seeded.');

    // Seed Allotments
    await targetClient.query(
      `INSERT INTO allotments (worker_id, job_card_id, meters_allotted, shift, date)
       VALUES ('wrk-01', 1, 500.00, 'Morning', CURRENT_DATE)`
    );
    await targetClient.query(
      `INSERT INTO allotments (worker_id, job_card_id, meters_allotted, shift, date)
       VALUES ('wrk-02', 2, 1200.00, 'Morning', CURRENT_DATE - 1)`
    );
    await targetClient.query(
      `INSERT INTO allotments (worker_id, job_card_id, meters_allotted, shift, date)
       VALUES ('wrk-03', 3, 750.00, 'Night', CURRENT_DATE)`
    );
    console.log('Allotments seeded.');

    // Seed Daily Efficiency (For past date)
    await targetClient.query(
      `INSERT INTO efficiency_daily (worker_id, date, allotted, done, efficiency_pct, flagged)
       VALUES ('wrk-02', CURRENT_DATE - 1, 1200.00, 1188.00, 99.00, false)
       ON CONFLICT DO NOTHING`
    );
    console.log('Daily efficiency seeded.');

    // Seed CCTV activity
    await targetClient.query(
      `INSERT INTO cctv_activity (worker_id, station, active_pct, idle_min)
       VALUES ('wrk-01', 'Weaving Bench 1', 82.5, 45.0)`
    );
    await targetClient.query(
      `INSERT INTO cctv_activity (worker_id, station, active_pct, idle_min)
       VALUES ('wrk-04', 'Folding Station A', 45.0, 180.0)`
    );
    console.log('CCTV activity seeded.');

    console.log('Database seeded successfully!');

  } catch (err) {
    console.error('Error executing schema/seeding:', err);
    process.exit(1);
  } finally {
    await targetClient.end();
  }
}

main();
