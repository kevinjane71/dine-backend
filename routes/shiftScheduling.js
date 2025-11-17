const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper function to group shifts by shift_id for calendar display
function groupShiftsByShiftId(shifts) {
  const grouped = {};
  shifts.forEach(shift => {
    const shiftId = shift.shiftId || `${shift.date}_${shift.startTime}`;
    if (!grouped[shiftId]) {
      grouped[shiftId] = {
        shiftId: shiftId,
        date: shift.date,
        shiftName: shift.shiftName,
        startTime: shift.startTime,
        endTime: shift.endTime,
        color: shift.color,
        employees: [],
        requiredEmployees: shift.requiredEmployees,
        requiredRoles: shift.requiredRoles,
        isUnderstaffed: shift.isUnderstaffed,
        hasConflicts: shift.hasConflicts,
        notes: shift.notes
      };
    }
    grouped[shiftId].employees.push({
      staffId: shift.staffId,
      role: shift.role,
      id: shift.id // Include the shift record ID for updates
    });
  });
  return Object.values(grouped);
}

// Get shifts for a restaurant
router.get('/shifts/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { startDate, endDate, grouped } = req.query;

    let query = db.collection('staffShifts')
      .where('restaurantId', '==', restaurantId);

    if (startDate && endDate) {
      query = query.where('date', '>=', startDate).where('date', '<=', endDate);
    }

    // Note: Firestore requires composite index for multiple orderBy
    // For now, order by date only, then sort in memory
    const snapshot = await query.orderBy('date', 'asc').get();
    let shifts = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Sort by date and startTime in memory
    shifts.sort((a, b) => {
      if (a.date !== b.date) {
        return a.date.localeCompare(b.date);
      }
      return (a.startTime || '').localeCompare(b.startTime || '');
    });

    // If grouped=true, return shifts grouped by shiftId for calendar display
    if (grouped === 'true') {
      const shiftGroups = groupShiftsByShiftId(shifts);
      return res.json({ success: true, shifts, shiftGroups });
    }

    res.json({ success: true, shifts });
  } catch (error) {
    console.error('Error fetching shifts:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch shifts' });
  }
});

// Create or update a shift
router.post('/shifts/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { staffId, date, startTime, endTime, role, notes } = req.body;

    if (!staffId || !date || !startTime || !endTime) {
      return res.status(400).json({ 
        success: false, 
        error: 'Staff ID, date, start time, and end time are required' 
      });
    }

    // Check if shift already exists for this staff member on this date
    const existingShift = await db.collection('staffShifts')
      .where('restaurantId', '==', restaurantId)
      .where('staffId', '==', staffId)
      .where('date', '==', date)
      .get();

    let shiftData = {
      restaurantId,
      staffId,
      date,
      startTime,
      endTime,
      role: role || 'employee',
      notes: notes || '',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    if (!existingShift.empty) {
      // Update existing shift
      const shiftId = existingShift.docs[0].id;
      shiftData.updatedAt = new Date();
      await db.collection('staffShifts').doc(shiftId).update(shiftData);
      res.json({ success: true, shift: { id: shiftId, ...shiftData } });
    } else {
      // Create new shift
      const shiftRef = await db.collection('staffShifts').add(shiftData);
      res.json({ success: true, shift: { id: shiftRef.id, ...shiftData } });
    }
  } catch (error) {
    console.error('Error creating/updating shift:', error);
    res.status(500).json({ success: false, error: 'Failed to create/update shift' });
  }
});

// Delete a shift
router.delete('/shifts/:shiftId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { shiftId } = req.params;
    await db.collection('staffShifts').doc(shiftId).delete();
    res.json({ success: true, message: 'Shift deleted successfully' });
  } catch (error) {
    console.error('Error deleting shift:', error);
    res.status(500).json({ success: false, error: 'Failed to delete shift' });
  }
});

// Bulk create shifts
router.post('/shifts/:restaurantId/bulk', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { shifts } = req.body;

    if (!Array.isArray(shifts) || shifts.length === 0) {
      return res.status(400).json({ success: false, error: 'Shifts array is required' });
    }

    const batch = db.batch();
    const createdShifts = [];

    for (const shift of shifts) {
      const { staffId, date, startTime, endTime, role, notes } = shift;
      
      if (!staffId || !date || !startTime || !endTime) {
        continue; // Skip invalid shifts
      }

      // Check if shift already exists
      const existingShift = await db.collection('staffShifts')
        .where('restaurantId', '==', restaurantId)
        .where('staffId', '==', staffId)
        .where('date', '==', date)
        .get();

      const shiftData = {
        restaurantId,
        staffId,
        date,
        startTime,
        endTime,
        role: role || 'employee',
        notes: notes || '',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      if (!existingShift.empty) {
        // Update existing
        const shiftId = existingShift.docs[0].id;
        const shiftRef = db.collection('staffShifts').doc(shiftId);
        batch.update(shiftRef, { ...shiftData, updatedAt: new Date() });
        createdShifts.push({ id: shiftId, ...shiftData });
      } else {
        // Create new
        const shiftRef = db.collection('staffShifts').doc();
        batch.set(shiftRef, shiftData);
        createdShifts.push({ id: shiftRef.id, ...shiftData });
      }
    }

    await batch.commit();
    res.json({ success: true, shifts: createdShifts, count: createdShifts.length });
  } catch (error) {
    console.error('Error bulk creating shifts:', error);
    res.status(500).json({ success: false, error: 'Failed to bulk create shifts' });
  }
});

// AI Auto-generate shifts with advanced constraints
router.post('/shifts/:restaurantId/auto-generate', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { startDate, endDate, preferences, shiftTypes } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ 
        success: false, 
        error: 'Start date and end date are required' 
      });
    }

    // Fetch all active staff for the restaurant
    const staffSnapshot = await db.collection(collections.users)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'active')
      .where('role', 'in', ['waiter', 'manager', 'employee', 'cook', 'bartender', 'server', 'dishwasher'])
      .get();

    const staff = [];
    for (const doc of staffSnapshot.docs) {
      const staffData = doc.data();
      
      // Fetch employee availability and preferences
      let availability = null;
      let employeePreferences = null;
      try {
        const availabilityDoc = await db.collection('staffAvailability').doc(doc.id).get();
        if (availabilityDoc.exists) {
          const availData = availabilityDoc.data();
          availability = availData.availability || null;
          employeePreferences = availData.preferences || null;
        }
      } catch (error) {
        console.log('Error fetching availability for staff:', doc.id, error);
      }

      staff.push({
        id: doc.id,
        name: staffData.name,
        role: staffData.role || 'employee',
        skills: staffData.skills || [staffData.role || 'employee'],
        availability: availability,
        maxHoursPerDay: employeePreferences?.maxHoursPerDay || 8,
        maxHoursPerWeek: employeePreferences?.maxHoursPerWeek || 40,
        preferredShifts: employeePreferences?.preferredShifts || [],
        experienceLevel: staffData.experienceLevel || 'intermediate',
        employmentType: staffData.employmentType || 'full-time',
        startDate: staffData.startDate
      });
    }

    if (staff.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No active staff members found' 
      });
    }

    // Fetch restaurant shift settings
    let restaurantSettings = null;
    try {
      const settingsDoc = await db.collection('restaurantShiftSettings').doc(restaurantId).get();
      if (settingsDoc.exists) {
        restaurantSettings = settingsDoc.data();
      }
    } catch (error) {
      console.log('Error fetching restaurant settings:', error);
    }

    // Use settings from DB or request, or defaults
    const finalShiftTypes = shiftTypes || restaurantSettings?.shiftTypes || [
      {
        name: 'Breakfast',
        startTime: '06:00',
        endTime: '11:00',
        requiredEmployees: 3,
        requiredRoles: { cook: 1, server: 2 },
        color: '#FFCC00'
      },
      {
        name: 'Lunch',
        startTime: '11:00',
        endTime: '15:00',
        requiredEmployees: 5,
        requiredRoles: { cook: 2, server: 2, bartender: 1 },
        color: '#00CCFF'
      },
      {
        name: 'Dinner',
        startTime: '17:00',
        endTime: '23:00',
        requiredEmployees: 6,
        requiredRoles: { cook: 2, server: 3, bartender: 1 },
        color: '#FF6B6B'
      }
    ];

    const finalPreferences = {
      operatingHours: preferences?.operatingHours || restaurantSettings?.operatingHours || { start: '06:00', end: '23:00' },
      peakHours: preferences?.peakHours || restaurantSettings?.peakHours || { 
        lunch: { start: '12:00', end: '14:00' },
        dinner: { start: '19:00', end: '21:00' }
      },
      minRestHours: preferences?.minRestHours || restaurantSettings?.minRestHours || 8,
      maxHoursPerWeek: preferences?.maxHoursPerWeek || restaurantSettings?.maxHoursPerWeek || 40,
      maxHoursPerDay: preferences?.maxHoursPerDay || restaurantSettings?.maxHoursPerDay || 8,
      timeOff: preferences?.timeOff || restaurantSettings?.timeOff || []
    };

    // Fetch existing shifts for the period
    const existingShiftsSnapshot = await db.collection('staffShifts')
      .where('restaurantId', '==', restaurantId)
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .get();

    const existingShifts = existingShiftsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Prepare comprehensive data for AI
    const staffInfo = staff.map(s => ({
      id: s.id,
      name: s.name,
      role: s.role,
      skills: s.skills,
      availability: s.availability,
      maxHoursPerDay: s.maxHoursPerDay,
      maxHoursPerWeek: s.maxHoursPerWeek,
      preferredShifts: s.preferredShifts,
      experienceLevel: s.experienceLevel,
      employmentType: s.employmentType
    }));

    // Generate shifts using AI with advanced constraints
    const aiPrompt = `You are an AI assistant tasked with generating an optimal weekly shift schedule for a restaurant that can be displayed on an interactive calendar UI.

**EMPLOYEES DATA:**
${JSON.stringify(staffInfo, null, 2)}

**SHIFT TYPES:**
${JSON.stringify(finalShiftTypes, null, 2)}

**RESTAURANT REQUIREMENTS:**
- Operating hours: ${finalPreferences.operatingHours.start} - ${finalPreferences.operatingHours.end}
- Peak hours: Lunch ${finalPreferences.peakHours.lunch?.start || '12:00'} - ${finalPreferences.peakHours.lunch?.end || '14:00'}, Dinner ${finalPreferences.peakHours.dinner?.start || '19:00'} - ${finalPreferences.peakHours.dinner?.end || '21:00'}
- Minimum rest hours between shifts: ${finalPreferences.minRestHours}
- Maximum hours per week per staff: ${finalPreferences.maxHoursPerWeek}
- Maximum hours per day per staff: ${finalPreferences.maxHoursPerDay}
- Time off (restaurant closed): ${finalPreferences.timeOff.length > 0 ? finalPreferences.timeOff.join(', ') : 'None'}

**EXISTING SHIFTS (to avoid conflicts):**
${existingShifts.length > 0 ? JSON.stringify(existingShifts.map(s => ({
  staffId: s.staffId,
  date: s.date,
  startTime: s.startTime,
  endTime: s.endTime
})), null, 2) : 'None'}

**CONSTRAINTS:**
1. Every shift must have the required number of employees with required roles/skills
2. No employee exceeds max hours per day/week
3. Minimum rest hours (${finalPreferences.minRestHours}) between shifts must be maintained
4. Respect preferred shifts when possible
5. Avoid assigning back-to-back undesirable shifts
6. Prioritize assigning experienced staff to peak shifts
7. Distribute work fairly among all staff
8. Consider employee availability (if provided)
9. DO NOT create shifts on days when restaurant is closed (time off days)
10. Follow the exact shift types and timings provided above

**OUTPUT FORMAT:**
Return a JSON array of shifts in this exact format (suitable for drag-and-drop calendar UI):
[
  {
    "shift_id": "mon_breakfast_1",
    "day": "Monday",
    "date": "YYYY-MM-DD",
    "shift_name": "Breakfast",
    "start_time": "06:00",
    "end_time": "11:00",
    "employees": [
      {"name": "Employee Name", "role": "cook", "staffId": "staff_id_here"}
    ],
    "required_employees": 3,
    "required_roles": {"cook": 1, "server": 2},
    "color": "#FFCC00",
    "notes": "Optional notes for special events or peak hours",
    "is_understaffed": false,
    "has_conflicts": false
  }
]

**IMPORTANT:**
- Generate shifts for the week from ${startDate} to ${endDate}
- Use day names (Monday, Tuesday, etc.) and ISO date format (YYYY-MM-DD)
- Each shift_id should be unique (e.g., "mon_breakfast_1", "tue_lunch_1")
- Assign employees based on their skills matching required roles
- Mark is_understaffed=true if you cannot meet required employees count
- Mark has_conflicts=true if there are scheduling conflicts
- Include all shift types for each day
- Return ONLY the JSON array, no other text or markdown formatting`;


    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that generates restaurant shift schedules. Always return valid JSON arrays.'
        },
        {
          role: 'user',
          content: aiPrompt
        }
      ],
      temperature: 0.7,
      max_tokens: 4000
    });

    let generatedShifts = [];
    try {
      const responseText = completion.choices[0].message.content.trim();
      // Extract JSON from response (handle markdown code blocks)
      let jsonText = responseText;
      
      // Remove markdown code blocks if present
      if (jsonText.includes('```json')) {
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      } else if (jsonText.includes('```')) {
        jsonText = jsonText.replace(/```\n?/g, '').trim();
      }
      
      // Try to find JSON array
      const jsonMatch = jsonText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      }
      
      // Try to fix common JSON issues
      // Remove trailing commas before closing brackets/braces
      jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1');
      
      generatedShifts = JSON.parse(jsonText);
    } catch (parseError) {
      console.error('Error parsing AI response:', parseError);
      console.error('Response text (first 1000 chars):', completion.choices[0].message.content.substring(0, 1000));
      // Fallback: Generate basic shifts
      generatedShifts = generateBasicShifts(staff, startDate, endDate, finalPreferences, finalShiftTypes);
    }

    // Process AI-generated shifts (new format with employees array)
    const batch = db.batch();
    const savedShifts = [];
    const staffNameMap = {};
    staff.forEach(s => {
      staffNameMap[s.name.toLowerCase()] = s;
    });

    for (const shiftData of generatedShifts) {
      // Handle new format: shift has employees array
      if (shiftData.employees && Array.isArray(shiftData.employees)) {
        // Create a shift record for each employee
        for (const employee of shiftData.employees) {
          let staffMember = null;
          
          // Find staff by staffId or name
          if (employee.staffId) {
            staffMember = staff.find(s => s.id === employee.staffId);
          }
          if (!staffMember && employee.name) {
            staffMember = staffNameMap[employee.name.toLowerCase()];
          }
          
          if (!staffMember) {
            console.warn(`Staff not found for employee:`, employee);
            continue;
          }

          // Check if shift already exists for this staff member on this date/time
          const existing = await db.collection('staffShifts')
            .where('restaurantId', '==', restaurantId)
            .where('staffId', '==', staffMember.id)
            .where('date', '==', shiftData.date)
            .where('startTime', '==', shiftData.start_time)
            .get();

          const shiftRecord = {
            restaurantId,
            staffId: staffMember.id,
            date: shiftData.date,
            startTime: shiftData.start_time,
            endTime: shiftData.end_time,
            shiftName: shiftData.shift_name || shiftData.shiftName || '',
            shiftId: shiftData.shift_id || shiftData.shiftId || '',
            role: employee.role || staffMember.role,
            notes: shiftData.notes || '',
            color: shiftData.color || '#FFCC00',
            isUnderstaffed: shiftData.is_understaffed || false,
            hasConflicts: shiftData.has_conflicts || false,
            requiredEmployees: shiftData.required_employees || shiftData.requiredEmployees || 0,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          
          // Only add requiredRoles if it exists and is not undefined
          if (shiftData.required_roles || shiftData.requiredRoles) {
            shiftRecord.requiredRoles = shiftData.required_roles || shiftData.requiredRoles;
          }

          if (!existing.empty) {
            const shiftId = existing.docs[0].id;
            const shiftRef = db.collection('staffShifts').doc(shiftId);
            batch.update(shiftRef, { ...shiftRecord, updatedAt: new Date() });
            savedShifts.push({ id: shiftId, ...shiftRecord });
          } else {
            const shiftRef = db.collection('staffShifts').doc();
            batch.set(shiftRef, shiftRecord);
            savedShifts.push({ id: shiftRef.id, ...shiftRecord });
          }
        }
      } else {
        // Handle old format: single staffId per shift
        const shiftRecord = {
          restaurantId,
          staffId: shiftData.staffId || shiftData.staff_id,
          date: shiftData.date,
          startTime: shiftData.startTime || shiftData.start_time,
          endTime: shiftData.endTime || shiftData.end_time,
          shiftName: shiftData.shift_name || shiftData.shiftName || '',
          shiftId: shiftData.shift_id || shiftData.shiftId || '',
          role: shiftData.role || 'employee',
          notes: shiftData.notes || '',
          color: shiftData.color || '#FFCC00',
          isUnderstaffed: shiftData.is_understaffed || false,
          hasConflicts: shiftData.has_conflicts || false,
          requiredEmployees: shiftData.required_employees || shiftData.requiredEmployees || 0,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        
        // Only add requiredRoles if it exists and is not undefined
        if (shiftData.required_roles || shiftData.requiredRoles) {
          shiftRecord.requiredRoles = shiftData.required_roles || shiftData.requiredRoles;
        }

        if (!shiftRecord.staffId) {
          console.warn('Skipping shift without staffId:', shiftData);
          continue;
        }

        const existing = await db.collection('staffShifts')
          .where('restaurantId', '==', restaurantId)
          .where('staffId', '==', shiftRecord.staffId)
          .where('date', '==', shiftRecord.date)
          .get();

        if (!existing.empty) {
          const shiftId = existing.docs[0].id;
          const shiftRef = db.collection('staffShifts').doc(shiftId);
          batch.update(shiftRef, { ...shiftRecord, updatedAt: new Date() });
          savedShifts.push({ id: shiftId, ...shiftRecord });
        } else {
          const shiftRef = db.collection('staffShifts').doc();
          batch.set(shiftRef, shiftRecord);
          savedShifts.push({ id: shiftRef.id, ...shiftRecord });
        }
      }
    }

    await batch.commit();

    res.json({ 
      success: true, 
      shifts: savedShifts, 
      count: savedShifts.length,
      message: `Generated ${savedShifts.length} shifts successfully`,
      shiftGroups: groupShiftsByShiftId(savedShifts) // Group by shift_id for calendar display
    });
  } catch (error) {
    console.error('Error auto-generating shifts:', error);
    res.status(500).json({ success: false, error: 'Failed to auto-generate shifts' });
  }
});


// Helper function for basic shift generation (fallback)
function generateBasicShifts(staff, startDate, endDate, preferences, shiftTypes) {
  const shifts = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  const defaultShiftTypes = shiftTypes || [
    { name: 'Breakfast', startTime: '06:00', endTime: '11:00', requiredEmployees: 3 },
    { name: 'Lunch', startTime: '11:00', endTime: '15:00', requiredEmployees: 5 },
    { name: 'Dinner', startTime: '17:00', endTime: '23:00', requiredEmployees: 6 }
  ];

  for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
    const dateStr = date.toISOString().split('T')[0];
    const dayOfWeek = date.getDay();
    const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });

    // Skip Sundays if configured
    if (preferences?.skipDays?.includes(dayOfWeek)) {
      continue;
    }

    // Create shifts for each shift type
    defaultShiftTypes.forEach((shiftType, typeIndex) => {
      const shiftId = `${dayName.toLowerCase().substring(0, 3)}_${shiftType.name.toLowerCase()}_${typeIndex + 1}`;
      const requiredCount = shiftType.requiredEmployees || 2;
      const staffForShift = staff.slice(0, Math.min(requiredCount, staff.length));
      
      staffForShift.forEach((member) => {
        shifts.push({
          shift_id: shiftId,
          day: dayName,
          date: dateStr,
          shift_name: shiftType.name,
          start_time: shiftType.startTime,
          end_time: shiftType.endTime,
          employees: [{
            name: member.name,
            role: member.role || 'employee',
            staffId: member.id
          }],
          required_employees: requiredCount,
          color: shiftType.color || '#FFCC00',
          is_understaffed: staffForShift.length < requiredCount,
          has_conflicts: false
        });
      });
    });
  }

  return shifts;
}

// Get staff availability preferences
router.get('/availability/:staffId', authenticateToken, async (req, res) => {
  try {
    const { staffId } = req.params;
    const availabilityDoc = await db.collection('staffAvailability').doc(staffId).get();
    
    if (availabilityDoc.exists) {
      res.json({ success: true, availability: availabilityDoc.data() });
    } else {
      res.json({ success: true, availability: null });
    }
  } catch (error) {
    console.error('Error fetching availability:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch availability' });
  }
});

// Update staff availability preferences
router.post('/availability/:staffId', authenticateToken, async (req, res) => {
  try {
    const { staffId } = req.params;
    const { preferences } = req.body;

    await db.collection('staffAvailability').doc(staffId).set({
      staffId,
      preferences,
      updatedAt: new Date()
    }, { merge: true });

    res.json({ success: true, message: 'Availability updated successfully' });
  } catch (error) {
    console.error('Error updating availability:', error);
    res.status(500).json({ success: false, error: 'Failed to update availability' });
  }
});

// Get restaurant shift settings/preferences
router.get('/settings/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const settingsDoc = await db.collection('restaurantShiftSettings').doc(restaurantId).get();
    
    if (settingsDoc.exists) {
      res.json({ success: true, settings: settingsDoc.data() });
    } else {
      // Return default settings
      res.json({ 
        success: true, 
        settings: {
          shiftTypes: [
            {
              name: 'Breakfast',
              startTime: '06:00',
              endTime: '11:00',
              requiredEmployees: 3,
              requiredRoles: { cook: 1, server: 2 },
              color: '#FFCC00'
            },
            {
              name: 'Lunch',
              startTime: '11:00',
              endTime: '15:00',
              requiredEmployees: 5,
              requiredRoles: { cook: 2, server: 2, bartender: 1 },
              color: '#00CCFF'
            },
            {
              name: 'Dinner',
              startTime: '17:00',
              endTime: '23:00',
              requiredEmployees: 6,
              requiredRoles: { cook: 2, server: 3, bartender: 1 },
              color: '#FF6B6B'
            }
          ],
          operatingHours: { start: '06:00', end: '23:00' },
          peakHours: { 
            lunch: { start: '12:00', end: '14:00' },
            dinner: { start: '19:00', end: '21:00' }
          },
          minRestHours: 8,
          maxHoursPerWeek: 40,
          maxHoursPerDay: 8,
          timeOff: [] // Days when restaurant is closed
        }
      });
    }
  } catch (error) {
    console.error('Error fetching shift settings:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch shift settings' });
  }
});

// Update restaurant shift settings/preferences
router.post('/settings/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { shiftTypes, operatingHours, peakHours, minRestHours, maxHoursPerWeek, maxHoursPerDay, timeOff } = req.body;

    const settings = {
      restaurantId,
      shiftTypes: shiftTypes || [],
      operatingHours: operatingHours || { start: '06:00', end: '23:00' },
      peakHours: peakHours || { 
        lunch: { start: '12:00', end: '14:00' },
        dinner: { start: '19:00', end: '21:00' }
      },
      minRestHours: minRestHours || 8,
      maxHoursPerWeek: maxHoursPerWeek || 40,
      maxHoursPerDay: maxHoursPerDay || 8,
      timeOff: timeOff || [],
      updatedAt: new Date()
    };

    await db.collection('restaurantShiftSettings').doc(restaurantId).set(settings, { merge: true });

    res.json({ success: true, settings, message: 'Shift settings updated successfully' });
  } catch (error) {
    console.error('Error updating shift settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update shift settings' });
  }
});

module.exports = router;

