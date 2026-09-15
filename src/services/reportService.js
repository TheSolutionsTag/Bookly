const PDFDocument = require('pdfkit');
const pool = require('../db/pool');

/**
 * Meeting-history document generation (admin-facing, see
 * routes/reports.js). Reads directly from `appointments` - the real
 * source of truth - never ChatMate360's `chatbot_bookly_appointments`
 * mirror, which exists for that integration's own bookkeeping only.
 */
async function fetchMeetingHistory({ from, to, resource_id } = {}) {
  const conditions = [];
  const values = [];
  if (resource_id) {
    values.push(resource_id);
    conditions.push(`a.resource_id = $${values.length}`);
  }
  if (from) {
    values.push(from);
    conditions.push(`a.start_time >= $${values.length}`);
  }
  if (to) {
    values.push(to);
    conditions.push(`a.start_time <= $${values.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT a.id, a.start_time, a.end_time, a.customer_name, a.customer_email, a.status, a.notes, a.attachment_url,
            r.name AS resource_name
     FROM appointments a
     JOIN resources r ON r.id = a.resource_id
     ${where}
     ORDER BY a.start_time ASC`,
    values
  );
  return rows;
}

/**
 * Streams a PDF listing meeting history straight to the response - no
 * temp file, no intermediate buffer for the whole document. One row per
 * appointment: date, time, staff/resource, attendee, status, and any note.
 * Returns the number of appointments included (for logging/response
 * headers), resolved once the document has finished writing.
 */
function streamMeetingHistoryPdf(res, rows, { from, to, resource_id } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.on('error', reject);
    res.on('finish', () => resolve(rows.length));
    doc.pipe(res);

    doc.fontSize(18).text('Bookly — Meeting History', { align: 'left' });
    const filterParts = [];
    if (resource_id) filterParts.push(`resource_id: ${resource_id}`);
    if (from) filterParts.push(`from: ${from}`);
    if (to) filterParts.push(`to: ${to}`);
    doc
      .fontSize(10)
      .fillColor('#555555')
      .text(filterParts.length > 0 ? `Filters — ${filterParts.join(', ')}` : 'Filters — none (all appointments)');
    doc.fillColor('#000000');
    doc.moveDown();

    if (rows.length === 0) {
      doc.fontSize(11).text('No appointments match this range.');
      doc.end();
      return;
    }

    for (const row of rows) {
      const start = new Date(row.start_time);
      const end = new Date(row.end_time);
      const dateLabel = start.toISOString().slice(0, 10);
      const timeLabel = `${start.toISOString().slice(11, 16)}–${end.toISOString().slice(11, 16)} UTC`;

      doc.fontSize(12).fillColor('#000000').text(`${dateLabel}  ${timeLabel}  —  ${row.resource_name}`, { continued: false });
      doc
        .fontSize(10)
        .fillColor('#333333')
        .text(`Attendee: ${row.customer_name} <${row.customer_email}>    Status: ${row.status}`);
      if (row.notes) {
        doc.fontSize(10).fillColor('#333333').text(`Notes: ${row.notes}`);
      }
      if (row.attachment_url) {
        doc.fontSize(10).fillColor('#333333').text(`Attachment: ${row.attachment_url}`);
      }
      doc.moveDown(0.75);
    }

    doc.end();
  });
}

module.exports = { fetchMeetingHistory, streamMeetingHistoryPdf };
