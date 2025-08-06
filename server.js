require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || 
        file.mimetype === 'application/vnd.ms-excel' || 
        file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are allowed'));
    }
  }
});

// BugHerd API configuration
const BUGHERD_API_BASE = 'https://www.bugherd.com/api_v2';
const BUGHERD_API_KEY = process.env.BUGHERD_API_KEY;

if (!BUGHERD_API_KEY) {
  console.error('ERROR: BUGHERD_API_KEY is not set in .env file');
  process.exit(1);
}

// Create axios instance for BugHerd API
const bugherdApi = axios.create({
  baseURL: BUGHERD_API_BASE,
  auth: {
    username: BUGHERD_API_KEY,
    password: 'x' // BugHerd API requires a non-empty password
  },
  headers: {
    'Accept': 'application/json',
    'Authorization': `Bearer ${BUGHERD_API_KEY}`
  }
});

// Helper function to handle API errors
const handleApiError = (error, res) => {
  console.error('API Error:', error.response?.data || error.message);
  const status = error.response?.status || 500;
  const message = error.response?.data?.message || 'An error occurred while processing your request';
  res.status(status).json({ error: message });
};

// Get all projects
app.get('/api/projects', async (req, res) => {
  try {
    console.log('Fetching projects from BugHerd API...');
    console.log('Using API Key:', BUGHERD_API_KEY ? '***' + BUGHERD_API_KEY.slice(-4) : 'Not set');
    
    console.log('Making request to BugHerd API...');
    const response = await bugherdApi.get('/projects.json');
    
    console.log('BugHerd API response status:', response.status);
    console.log('Response headers:', JSON.stringify(response.headers, null, 2));
    console.log('Response data type:', typeof response.data);
    console.log('Response data keys:', Object.keys(response.data || {}));
    
    // Check if the response has the expected format
    let projects = [];
    if (Array.isArray(response.data)) {
      projects = response.data;
    } else if (response.data && Array.isArray(response.data.projects)) {
      projects = response.data.projects;
    } else {
      console.error('Unexpected API response format:', JSON.stringify(response.data, null, 2));
      return res.status(500).json({
        success: false,
        error: 'Unexpected API response format',
        details: response.data
      });
    }
    
    console.log(`Found ${projects.length} projects`);
    res.json({
      success: true,
      projects: projects
    });
  } catch (error) {
    console.error('Error fetching projects:', error.message);
    console.error('Error details:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data
    });
    
    if (error.response?.status === 401) {
      return res.status(401).json({
        success: false,
        error: 'Invalid BugHerd API key. Please check your .env file and ensure BUGHERD_API_KEY is set correctly.'
      });
    }
    
    handleApiError(error, res);
  }
});

// Helper function to get priority mapping for BugHerd
function getBugHerdPriority(priorityName) {
  // BugHerd's priority mapping - map priority names to IDs
  const priorityMap = {
    'critical': { id: 1, name: 'critical' },    // Critical (highest)
    'important': { id: 2, name: 'important' },   // Important
    'normal': { id: 3, name: 'normal' },         // Normal
    'minor': { id: 4, name: 'minor' },           // Minor (lowest)
    'not set': { id: 0, name: 'not set' },       // Not set
  };
  
  // Default to normal if priority is not in the map
  return priorityMap[priorityName?.toLowerCase()] || priorityMap['normal'];
}

// Function to update task priority
async function updateTaskPriority(projectId, taskId, priority) {
  try {
    console.log(`Updating priority for task ${taskId} to ${priority.name}`);
    const response = await bugherdApi.put(
      `/projects/${projectId}/tasks/${taskId}.json`,
      { 
        task: { 
          priority: priority.name,
          // Include required fields that might be needed
          status: 'QA Team' // This will be updated to the actual status in the main flow
        } 
      }
    );
    console.log(`Priority updated for task ${taskId}:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`Error updating priority for task ${taskId}:`, error.message);
    throw error;
  }
}

// Parse CSV file
const parseCSV = (filePath) => {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
};

// Parse Excel file
const parseExcel = (filePath) => {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  return xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
};

// Upload and process file
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!req.body.projectId) {
      return res.status(400).json({ error: 'Project ID is required' });
    }

    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    let bugs = [];

    try {
      // Parse the uploaded file based on its extension
      if (fileExt === '.csv') {
        bugs = await parseCSV(filePath);
      } else if (['.xlsx', '.xls'].includes(fileExt)) {
        bugs = parseExcel(filePath);
      } else {
        throw new Error('Unsupported file format');
      }

      // Process each bug and create in BugHerd
      const results = [];
      for (const bug of bugs) {
        try {
          // Map CSV fields to BugHerd API fields
          const priorityName = bug.priority || 'not set'; // Read priority name from CSV
          const priority = getBugHerdPriority(priorityName);
          
                          // Format the description with additional details
          let description = bug.description || '';
          const details = [];
          
          // Add environment details
          if (bug.os) details.push(`OS: ${bug.os}`);
          if (bug.browser) details.push(`Browser: ${bug.browser} ${bug.browser_version || ''}`.trim());
          if (bug.resolution) details.push(`Resolution: ${bug.resolution}`);
          if (bug.browser_size) details.push(`Browser Window: ${bug.browser_size}`);
          
          // Add URL at the bottom if available
          const siteUrl = bug.site || bug.siteUrl || bug.url || '';
          if (siteUrl) {
            details.push(`URL: ${siteUrl}`);
          }
          
          if (details.length > 0) {
            description += '\n\n' + details.join('\n');
          }
          
          const bugData = {
            description: description,
            priority: priority.name,
            priority_id: priority.id, // Add the mapped priority_id
            status: bug.status || 'backlog',
            tag_names: bug.tags ? bug.tags.split(',').map(tag => tag.trim()) : [],
            requester_email: bug.requester_email,
            requester_name: 'CSV Importer',
            browser: bug.browser || '',
            browser_version: '',
            os: bug.os || '',
            resolution: bug.resolution || '',
            site_page: bug.site || ''
          };
          
          // Add severity as a custom field
          if (bug.severity) {
            // First, ensure tag_names exists
            bugData.tag_names = bugData.tag_names || [];
            
            // Add severity as both a tag and custom field
            const severityValue = bug.severity.toLowerCase().trim();
            bugData.tag_names.push(`severity:${severityValue}`);
            
            // Add as custom field (BugHerd's format)
            bugData.custom_fields = [
              {
                id: 'severity', // This should match your custom field ID in BugHerd
                value: severityValue
              }
            ];
          }
          
          console.log('Creating bug with data:', JSON.stringify({
            project_id: req.body.projectId,
            task: bugData
          }, null, 2));

          // Create bug in BugHerd
          const response = await bugherdApi.post(
            `/projects/${req.body.projectId}/tasks.json`,
            { task: bugData }
          );
          
          console.log('Bug created successfully:', response.data);
          
          // Update priority separately if needed
          if (priority && priority.id !== 0) { // If not normal priority (3)
            try {
              await updateTaskPriority(
                req.body.projectId,
                response.data.id,
                priority
              );
            } catch (error) {
              console.error('Error updating priority, but bug was created:', error.message);
              // Continue even if priority update fails
            }
          }

          results.push({
            id: bug.id,
            status: 'success',
            bugherdId: response.data.id,
            url: response.data.url
          });
        } catch (error) {
          console.error(`Error creating bug ${bug.id}:`, error.message);
          results.push({
            id: bug.id,
            status: 'error',
            error: error.message
          });
        }
      }

      // Clean up the uploaded file
      fs.unlinkSync(filePath);

      res.json({
        success: true,
        total: bugs.length,
        results
      });
    } catch (error) {
      // Clean up the uploaded file in case of error
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      throw error;
    }
  } catch (error) {
    handleApiError(error, res);
  }
});

// Export bugs from BugHerd
app.post('/api/export', async (req, res) => {
  console.log('=== EXPORT REQUEST RECEIVED ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  let response;  // Moved to outer scope for error handling
  
  try {
    // Validate request body
    if (!req.body) {
      console.error('No request body received');
      return res.status(400).json({ error: 'Request body is required' });
    }
    
    const { projectId, filters } = req.body;
    
    console.log('=== VALIDATING REQUEST ===');
    console.log('Project ID:', projectId);
    console.log('Filters:', filters ? JSON.stringify(filters, null, 2) : 'No filters provided');

    // Validate projectId
    if (!projectId) {
      const error = 'Validation failed: Project ID is required';
      console.error(error);
      return res.status(400).json({ 
        success: false,
        error: error,
        receivedData: { projectId, hasFilters: !!filters }
      });
    }

    // Validate filters
    if (!filters || (typeof filters !== 'object') || 
        (!filters.feedback && !filters.taskBoard && !filters.archive)) {
      const error = 'Validation failed: At least one filter must be enabled';
      console.error(error);
      return res.status(400).json({ 
        success: false,
        error: error,
        receivedFilters: filters
      });
    }

    console.log('Exporting bugs from BugHerd...');
    console.log('Project ID:', projectId);
    console.log('Filters:', filters);

    // Fetch all tasks from BugHerd API with pagination
    let tasks = [];
    const perPage = 100; // BugHerd API max per_page is usually 100
    let page = 1;
    let hasMore = true;

    try {
      while (hasMore) {
        console.log(`Fetching page ${page} of tasks (with attachments)...`);
        const response = await bugherdApi.get(`/projects/${projectId}/tasks.json`, {
          params: { page, per_page: perPage, include: 'attachments' },
          timeout: 30000
        });
        if (!response.data || !Array.isArray(response.data.tasks)) {
          break;
        }
        const pageTasks = response.data.tasks;
        console.log(`Fetched ${pageTasks.length} tasks from page ${page}`);
        tasks = [...tasks, ...pageTasks];
        if (pageTasks.length < perPage) {
          hasMore = false;
        } else {
          page++;
        }
      }

      console.log(`Total tasks fetched: ${tasks.length}`);

      console.log(`Processing ${tasks.length} tasks`);
    } catch (error) {
      console.error('Error fetching tasks from BugHerd:', error);
      const errorDetails = {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      };
      console.error('Error details:', JSON.stringify(errorDetails, null, 2));
      return res.status(500).json({ 
        error: 'Failed to fetch tasks from BugHerd API',
        details: errorDetails,
        status: error.response?.status
      });
    }

    // Use the tasks variable that was already set from the API response
    console.log(`Found ${tasks.length} total tasks`);

    console.log('=== FILTERING TASKS ===');
    console.log(`Total tasks received: ${tasks.length}`);
    console.log('First task sample:', JSON.stringify(tasks[0], null, 2));
    
    // Ensure tasks is an array before filtering
    if (!Array.isArray(tasks)) {
      console.error('Tasks is not an array:', typeof tasks, tasks);
      return res.status(500).json({ 
        error: 'Invalid tasks data format',
        details: 'Expected an array of tasks',
        receivedType: typeof tasks,
        sampleTask: tasks
      });
    }
    
    // Filter tasks based on enabled filters
    let filteredTasks = [];
    
    if (filters.feedback) {
      console.log('Filtering feedback tasks...');
      const feedbackTasks = tasks.filter(task => {
        const status = String(task.status || '').toLowerCase();
        return status === 'feedback';
      });
      console.log(`Found ${feedbackTasks.length} feedback tasks`);
      filteredTasks = [...filteredTasks, ...feedbackTasks];
    }
    
    if (filters.taskBoard) {
      console.log('Filtering task board tasks...');
      const taskBoardStatuses = [
        'backlog', 'qa team', 'in progress', 'done',
        'Backlog', 'QA Team', 'In Progress', 'Done'
      ];
      
      const taskBoardTasks = tasks.filter(task => {
        const status = String(task.status || '').toLowerCase();
        return taskBoardStatuses.includes(status);
      });
      
      console.log(`Found ${taskBoardTasks.length} task board tasks`);
      filteredTasks = [...filteredTasks, ...taskBoardTasks];
    }
    
    if (filters.archive) {
      console.log('Filtering archive tasks...');
      // Check both status and status_id for archive tasks
      const archiveTasks = tasks.filter(task => {
        const status = String(task.status || '').toLowerCase();
        const statusId = parseInt(task.status_id || '0');
        
        // Archive status can be indicated by status text or status_id
        const isArchived = 
          status.includes('archive') || 
          status.includes('closed') ||
          statusId === 5; // Assuming 5 is the ID for closed/archived status
          
        console.log(`Task ${task.id} - status: ${status}, status_id: ${statusId}, isArchived: ${isArchived}`);
        return isArchived;
      });
      
      console.log(`Found ${archiveTasks.length} archive tasks`);
      console.log('Sample archive tasks:', JSON.stringify(archiveTasks.slice(0, 3), null, 2));
      filteredTasks = [...filteredTasks, ...archiveTasks];
    }
    
    console.log(`Total filtered tasks: ${filteredTasks.length}`);

    // Remove duplicates (in case a task matches multiple filters)
    const duplicateIds = [];
    const uniqueTasks = filteredTasks.filter((task, index, self) => {
      const firstIndex = self.findIndex(t => t.id === task.id);
      if (index !== firstIndex) {
        duplicateIds.push(task.id);
      }
      return index === firstIndex;
    });

    console.log(`Filtered tasks (before deduplication): ${filteredTasks.length}`);
    console.log(`Duplicate task IDs removed:`, duplicateIds);
    console.log(`Exporting ${uniqueTasks.length} unique tasks`);

    // Fetch detailed info for each unique task (to get screenshot_url and attachments)
    console.log('Fetching detailed task info for each task (this may take a while)...');
    const detailedTasks = await Promise.all(uniqueTasks.map(async (task, idx) => {
      try {
        const response = await bugherdApi.get(`/projects/${projectId}/tasks/${task.id}.json`);
        const detailedTask = response.data.task || response.data;
        if (idx < 5) {
          console.log(`Task ${task.id} details:`, JSON.stringify({
            id: detailedTask.id,
            screenshot_url: detailedTask.screenshot_url,
            attachments: detailedTask.attachments
          }, null, 2));
        }
        // Merge with original task data, detailed data takes precedence
        return { ...task, ...detailedTask };
      } catch (error) {
        console.error(`Error fetching details for task ${task.id}:`, error.message);
        // If details can't be fetched, use the original
        return task;
      }
    }));
    console.log(`Fetched details for ${detailedTasks.length} tasks`);

    // Use detailedTasks instead of uniqueTasks for CSV export
    if (detailedTasks.length === 0) {
      console.log('No tasks found matching the selected filters');
      // If debug param is set, include debug info in the response
      if (req.query.debug === '1') {
        return res.status(404).json({
          error: 'No tasks found',
          message: 'No tasks match the selected filters',
          filters: filters,
          debug: {
            totalFetched: tasks.length,
            filteredCount: filteredTasks.length,
            duplicateIds: duplicateIds,
            uniqueCount: uniqueTasks.length
          }
        });
      }
      return res.status(404).json({ 
        error: 'No tasks found',
        message: 'No tasks match the selected filters',
        filters: filters
      });
    }

    // If debug param is set, return debug info instead of CSV
    if (req.query.debug === '1') {
      return res.json({
        success: true,
        debug: {
          totalFetched: tasks.length,
          filteredCount: filteredTasks.length,
          duplicateIds: duplicateIds,
          uniqueCount: uniqueTasks.length,
          sampleTasks: uniqueTasks.slice(0, 3)
        }
      });
    }

    // Convert detailed tasks to CSV format with all available fields
    const csvData = detailedTasks.map((task, index) => {
      try {
        // Helper function to safely get and format values
        const getValue = (value, defaultValue = '') => {
          if (value === null || value === undefined) return defaultValue;
          if (Array.isArray(value)) return value.join(', ');
          if (typeof value === 'object') return JSON.stringify(value);
          return String(value).trim();
        };

        // Extract task data with null checks and formatting
        const taskId = task.id || '';
        const status = getValue(task.status);
        // Map priority_id to readable string
        let priority = '';
        const priorityMap = {
          1: 'critical',
          2: 'important',
          3: 'normal',
          4: 'minor',
          0: 'not set',
        };
        if (typeof task.priority_id !== 'undefined') {
          priority = priorityMap[task.priority_id] || getValue(task.priority);
        } else {
          priority = getValue(task.priority);
        }
        const description = getValue(task.description);
        // Best effort to get the site URL for the Site URL column
        let siteUrl = getValue(task.site_url || task.site || task.url || task.site_page);
        if (siteUrl && !siteUrl.startsWith('http')) {
          siteUrl = `https://${siteUrl}`;
        }
        const os = getValue(task.os || task.operating_system);
        const browser = getValue(task.browser);
        const browserSize = getValue(task.browser_size || task.viewport);
        const resolution = getValue(task.resolution);
        // Screenshot logic: always use screenshot_url if present, otherwise fall back to first image attachment
        let screenshot = '';
        if (task.screenshot_url && typeof task.screenshot_url === 'string' && task.screenshot_url.trim() !== '') {
          screenshot = task.screenshot_url;
        } else if (Array.isArray(task.attachments)) {
          const imgAttachment = task.attachments.find(att => 
            att.content_type && 
            att.content_type.startsWith('image/') && 
            att.url
          );
          if (imgAttachment) {
            screenshot = imgAttachment.url;
          }
        } else if (task.screenshot && typeof task.screenshot === 'string') {
          screenshot = task.screenshot;
        }
        const tags = Array.isArray(task.tag_names) ? task.tag_names.join(', ') : getValue(task.tags);
        const dueAt = task.due_at ? new Date(task.due_at).toISOString() : '';
        const requesterEmail = getValue(task.requester_email);
        const taskUrl = task.id ? `https://www.bugherd.com/projects/${projectId}/tasks/${task.id}` : '';
        
        // Log task data for debugging
        if (index < 5) {
          console.log('--- FULL TASK OBJECT FOR DEBUGGING ---');
          console.log(JSON.stringify(task, null, 2));
        }
        console.log(`Processing task ${taskId} (CSV BugID: ${index + 1})`, {
          status,
          priority,
          description: description.substring(0, 50) + (description.length > 50 ? '...' : ''),
          siteUrl,
          screenshot,
        });
        
        // Return all available fields
        return {
          'BugID': (index + 1),
          'Bug Status': status,
          'Priority': priority,
          'Priority ID': task.priority_id || '',
          'Description': description,
          'Tags': tags,
          'Site URL': siteUrl,
          'OS': os,
          'Browser': browser,
          'Browser Size': browserSize,
          'Resolution': resolution,
          'Screenshot URL': screenshot,
          'Requester Email': requesterEmail,
          'Severity': priority,
          'Tags/Categories': tags
        };
      } catch (error) {
        console.error('Error formatting task for CSV:', error);
        console.error('Problematic task data:', JSON.stringify(task, null, 2));
        return null;
      }
    }).filter(task => task !== null); // Remove any null entries from failed mappings

    try {
      // Reorder headers to match the 2nd image
      const csvHeaders = [
        'BugID',
        'Bug Status',
        'Bug Type',
        'Severity',
        'Tags/Categories',
        'Description',
        'Site URL',
        'OS',
        'Browser',
        'Browser Size',
        'Resolution',
        'Screenshot URL',
        'Requester Email'
      ];

      // Create CSV content with headers
      let csvContent = '';
      
      // Helper function to escape CSV values
      const escapeCsv = (value) => {
        if (value === null || value === undefined) return '';
        // Handle non-string values
        if (typeof value !== 'string') {
          if (Array.isArray(value)) {
            value = value.join(', ');
          } else if (typeof value === 'object') {
            value = JSON.stringify(value);
          } else {
            value = String(value);
          }
        }
        // Escape quotes and wrap in quotes if value contains commas, quotes, or newlines
        if (/[,\n"]/.test(value)) {
          return '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
      };
      
      // Add headers
      csvContent += csvHeaders.map(escapeCsv).join(',') + '\n';
      
      // Add data rows with error handling for each row
      csvData.forEach(row => {
        try {
          if (row && typeof row === 'object') {
            // Map data to the new header order, filling missing columns with empty strings
            const rowData = csvHeaders.map(header => escapeCsv(row[header]));
            csvContent += rowData.join(',') + '\n';
          }
        } catch (rowError) {
          console.error('Error processing row for CSV:', rowError);
          console.error('Problematic row data:', JSON.stringify(row, null, 2));
        }
      });
      
      // Set response headers for CSV download
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=bugherd-tasks-${projectId}-${new Date().toISOString().split('T')[0]}.csv`);
      res.status(200).send(csvContent);
      console.log('CSV export completed successfully');
      
    } catch (error) {
      console.error('Error generating CSV:', error);
      res.status(500).json({ 
        error: 'Failed to generate CSV',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }

  } catch (error) {
    console.error('Export error:', error.message);
    console.error('Error details:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data
    });
    
    if (error.response?.status === 401) {
      return res.status(401).json({
        success: false,
        error: 'Invalid BugHerd API key. Please check your .env file and ensure BUGHERD_API_KEY is set correctly.'
      });
    }
    
    handleApiError(error, res);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: err.message || 'Internal server error' 
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});