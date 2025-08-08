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
  // BUGHERD_API_KEY is not set in .env file
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
  // API Error occurred
  const status = error.response?.status || 500;
  const message = error.response?.data?.message || 'An error occurred while processing your request';
  res.status(status).json({ error: message });
};

// Get all projects
app.get('/api/projects', async (req, res) => {
  try {
    // Fetching projects from BugHerd API
    const response = await bugherdApi.get('/projects.json');
    
    // Processing API response
    
    // Check if the response has the expected format
    let projects = [];
    if (Array.isArray(response.data)) {
      projects = response.data;
    } else if (response.data && Array.isArray(response.data.projects)) {
      projects = response.data.projects;
    } else {
      // Unexpected API response format
      return res.status(500).json({
        success: false,
        error: 'Unexpected API response format',
        details: response.data
      });
    }
    
    // Projects fetched successfully
    res.json({
      success: true,
      projects: projects
    });
  } catch (error) {
    // Error fetching projects
    
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
    // Updating task priority
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
    // Priority updated successfully
    return response.data;
  } catch (error) {
    // Error updating priority
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
          
          // Creating bug with provided data

          // Create bug in BugHerd
          const response = await bugherdApi.post(
            `/projects/${req.body.projectId}/tasks.json`,
            { task: bugData }
          );
          
          // Bug created successfully
          
          // Update priority separately if needed
          if (priority && priority.id !== 0) { // If not normal priority (3)
            try {
              await updateTaskPriority(
                req.body.projectId,
                response.data.id,
                priority
              );
            } catch (error) {
              // Error updating priority (non-critical)
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
          // Error creating bug
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
  // Export request received
  
  let response;  // Moved to outer scope for error handling
  
  try {
    // Validate request body
    if (!req.body) {
      // No request body received
      return res.status(400).json({ error: 'Request body is required' });
    }
    
    const { projectId, filters } = req.body;
    
    // Validating export request

    // Validate projectId
    if (!projectId) {
      const error = 'Validation failed: Project ID is required';
      // Validation error
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
      // Validation error
      return res.status(400).json({ 
        success: false,
        error: error,
        receivedFilters: filters
      });
    }

    // Starting export process

    // Debug log the project ID and filters
    console.log('Exporting tasks for project ID:', projectId);
    console.log('Using filters:', filters);

    // Fetch all tasks from BugHerd API with pagination
    let tasks = [];
    const perPage = 100; // BugHerd API max per_page is usually 100
    let page = 1;
    let hasMore = true;

    try {
      while (hasMore) {
        // Fetching page of tasks
        const response = await bugherdApi.get(`/projects/${projectId}/tasks.json`, {
          params: { page, per_page: perPage, include: 'attachments' },
          timeout: 30000
        });
        if (!response.data || !Array.isArray(response.data.tasks)) {
          break;
        }
        const pageTasks = response.data.tasks;
        // Page of tasks fetched
        tasks = [...tasks, ...pageTasks];
        if (pageTasks.length < perPage) {
          hasMore = false;
        } else {
          page++;
        }
      }

      // Tasks fetched and processing
    } catch (error) {
      const errorDetails = {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      };
      return res.status(500).json({ 
        error: 'Failed to fetch tasks from BugHerd API',
        details: errorDetails,
        status: error.response?.status
      });
    }

    // Use the tasks variable that was already set from the API response
    // Processing and filtering tasks
    
    // Ensure tasks is an array before filtering
    if (!Array.isArray(tasks)) {
      // Invalid tasks format
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
      // Filtering feedback tasks
      const feedbackTasks = tasks.filter(task => {
        const status = String(task.status || '').toLowerCase();
        return status === 'feedback';
      });
      // Feedback tasks filtered
      filteredTasks = [...filteredTasks, ...feedbackTasks];
    }
    
    if (filters.taskBoard) {
      // Filtering task board tasks
      const taskBoardTasks = tasks.filter(task => {
        if (!task.status) return false;
        const status = String(task.status).trim().toLowerCase();
        const taskBoardStatuses = [
          'backlog', 'qa team', 'in progress', 'done', 'in-progress','suggestion',
          'Backlog', 'QA Team', 'In Progress', 'Done', 'In-Progress','Suggestion'
        ];
        return taskBoardStatuses.some(s => status === s.toLowerCase());
      });
      // Task board tasks filtered
      filteredTasks = [...filteredTasks, ...taskBoardTasks];
    }
    
    if (filters.archive) {
      // Filtering archive tasks
      // Check both status and status_id for archive tasks
      const archiveTasks = tasks.filter(task => {
        const status = String(task.status || '').toLowerCase();
        const statusId = parseInt(task.status_id || '0');
        
        // Archive status can be indicated by status text or status_id
        const isArchived = 
          status.includes('archive') || 
          status.includes('closed') ||
          statusId === 5; // Assuming 5 is the ID for closed/archived status
          
        // Checking task archive status
        return isArchived;
      });
      
      // Archive tasks filtered
      filteredTasks = [...filteredTasks, ...archiveTasks];
    }
    
    // Tasks filtered

    // Remove duplicates (in case a task matches multiple filters)
    const duplicateIds = [];
    const uniqueTasks = filteredTasks.filter((task, index, self) => {
      const firstIndex = self.findIndex(t => t.id === task.id);
      if (index !== firstIndex) {
        duplicateIds.push(task.id);
      }
      return index === firstIndex;
    });

    // Tasks deduplicated

    // Fetch detailed info for each unique task (to get screenshot_url and attachments)
    // Fetching detailed task info
    const detailedTasks = await Promise.all(uniqueTasks.map(async (task, idx) => {
      try {
        const response = await bugherdApi.get(`/projects/${projectId}/tasks/${task.id}.json`);
        const detailedTask = response.data.task || response.data;
        if (idx < 5) {
          // Processing task details
        }
        // Merge with original task data, detailed data takes precedence
        return { ...task, ...detailedTask };
      } catch (error) {
        // Error fetching task details (non-critical)
        // If details can't be fetched, use the original
        return task;
      }
    }));
    // Task details fetched

    // Use detailedTasks instead of uniqueTasks for CSV export
    if (detailedTasks.length === 0) {
      // No tasks found matching filters
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

    // Helper to extract Browser, OS, Resolution, and Browser Window from description text
function extractEnvFromDescription(description) {
  const result = { os: '', browser: '', resolution: '', browserWindow: '' };
  if (typeof description !== 'string') return result;
  // Regex patterns (case-insensitive, tolerant to spaces)
  const osMatch = description.match(/OS\s*:\s*([^\n]+)/i);
  const browserMatch = description.match(/Browser\s*:\s*([^\n]+)/i);
  const resMatch = description.match(/Resolution\s*:?\s*([^\n]+)/i);
  const browserWindowMatch = description.match(/Browser\s*Window\s*:?\s*([^\n]+)/i);
  if (osMatch) result.os = osMatch[1].trim();
  if (browserMatch) result.browser = browserMatch[1].trim();
  if (resMatch) result.resolution = resMatch[1].trim();
  if (browserWindowMatch) result.browserWindow = browserWindowMatch[1].trim();
  return result;
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
        
        // Enhanced site URL extraction
        let siteUrl = '';
        
        // First try to extract from description if it contains a URL
        const urlRegex = /(?:https?:\/\/|www\.)[^\s\n]+/gi;
        const urlsInDescription = description.match(urlRegex) || [];
        
        // Check direct URL fields first
        const possibleUrlFields = [
          task.site_url, 
          task.site, 
          task.url, 
          task.URL, 
          task.site_page,
          task.page_url,
          task.page,
          ...urlsInDescription  // Add any URLs found in description
        ];
        
        // Find the first non-empty URL
        for (const url of possibleUrlFields) {
          if (url && typeof url === 'string' && url.trim() !== '') {
            siteUrl = url.trim();
            // Ensure URL has protocol
            if (!siteUrl.startsWith('http')) {
              siteUrl = `https://${siteUrl.replace(/^\/+/, '')}`; // Remove leading slashes before adding protocol
            }
            // Clean up the URL
            siteUrl = siteUrl.replace(/"/g, '').replace(/\n/g, '').trim();
            // If we found a URL in the description, take the first one and break
            if (urlsInDescription.includes(url)) {
              break;
            }
          }
        }

        
        // Extract environment information
        let os = getValue(task.requester_os || task.os || task.operating_system);
        let browser = getValue(task.requester_browser || task.browser);
        let browserSize = getValue(task.requester_browser_size || task.browser_size || task.viewport || task.window_size || task.browser_window_size);
        let resolution = getValue(task.requester_resolution || task.resolution || task.screen_resolution);
        
        // Extract environment details from description
        const env = extractEnvFromDescription(description);
        
        // Fill in missing fields from description with better fallbacks
        if (!os) os = env.os;
        if (!browser) browser = env.browser;
        
        // Handle resolution and browser size with better logic
        if (env.browserWindow) {
            // If we have browser window from description, use it for browserSize
            browserSize = env.browserWindow;
        }
        
        if (!resolution) {
            resolution = env.resolution || browserSize;
        }
        
        // If we still don't have browser size but have resolution, use resolution
        if (!browserSize && resolution) {
            browserSize = resolution;
        }
        
        // Enhanced screenshot extraction
        let screenshot = '';
        
        // 1. Check direct screenshot fields first
        const possibleScreenshotFields = [
          task.screenshot_url,
          task.screenshot,
          task.image_url,
          task.attachment_url
        ];
        
        for (const field of possibleScreenshotFields) {
          if (field && typeof field === 'string' && field.trim() !== '') {
            screenshot = field.trim();
            break;
          }
        }
        
        // 2. If no direct screenshot URL, check attachments
        if (!screenshot && Array.isArray(task.attachments)) {
          // Look for image attachments first
          const imgAttachment = task.attachments.find(att => 
            att.content_type && 
            att.content_type.startsWith('image/') && 
            att.url
          );
          
          if (imgAttachment) {
            screenshot = imgAttachment.url;
          } else if (task.attachments.length > 0) {
            // Fall back to any attachment if no image found
            screenshot = task.attachments[0].url || '';
          }
        }
        
        // 3. If still no screenshot, try to extract from description
        if (!screenshot && description) {
          // Look for screenshot URL in the format: "Screenshot: <URL>"
          const screenshotMatch = description.match(/Screenshot:\s*(https?:\/\/[^\s\n]+)/i);
          if (screenshotMatch && screenshotMatch[1]) {
            screenshot = screenshotMatch[1].trim();
          } else {
            // Fallback: Look for any image URL in the description
            const imgUrlMatch = description.match(/(https?:\/\/[^\s\n]+\.(?:jpg|jpeg|png|gif|webp|bmp)(?:\?[^\s\n]*)?)/i);
            if (imgUrlMatch && imgUrlMatch[0]) {
              screenshot = imgUrlMatch[0].trim();
            }
          }
        }
        
        const tags = Array.isArray(task.tag_names) ? task.tag_names.join(', ') : getValue(task.tags);
        // const dueAt = task.due_at ? new Date(task.due_at).toISOString() : '';
        const requesterEmail = getValue(task.requester_email);
        // const taskUrl = task.id ? `https://www.bugherd.com/projects/${projectId}/tasks/${task.id}` : '';
        
        // Return all available fields
        return {
          'BugID': (index + 1),
          'Bug Status': 'New',
          'Bug Type': (status && status.toLowerCase() === 'suggestion' ? 'Suggestion' : (status && status.toLowerCase() === 'qa team' ? 'Bug' : status)),
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
        }
      });
      
      // Set response headers for CSV download
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=bugherd-tasks-${projectId}-${new Date().toISOString().split('T')[0]}.csv`);
      res.status(200).send(csvContent);
      
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to generate CSV',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }

  } catch (error) {
    
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
  res.status(500).json({ 
    error: err.message || 'Internal server error' 
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});