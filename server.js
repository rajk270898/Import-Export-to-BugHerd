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
    'Accept': 'application/json'
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
  try {
    const { projectId, filters } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'Project ID is required' });
    }

    if (!filters || (!filters.feedback && !filters.taskBoard && !filters.archive)) {
      return res.status(400).json({ error: 'At least one filter must be enabled' });
    }

    console.log('Exporting bugs from BugHerd...');
    console.log('Project ID:', projectId);
    console.log('Filters:', filters);

    // Get all tasks for the project
    const response = await bugherdApi.get(`/projects/${projectId}/tasks.json`);
    
    if (!response.data || !Array.isArray(response.data)) {
      return res.status(500).json({ error: 'Failed to fetch tasks from BugHerd' });
    }

    let tasks = response.data;
    console.log(`Found ${tasks.length} total tasks`);

    // Filter tasks based on enabled filters
    let filteredTasks = [];
    
    if (filters.feedback) {
      const feedbackTasks = tasks.filter(task => task.status === 'feedback' || task.status === 'Feedback');
      filteredTasks = filteredTasks.concat(feedbackTasks);
      console.log(`Found ${feedbackTasks.length} feedback tasks`);
    }
    
    if (filters.taskBoard) {
      const taskBoardTasks = tasks.filter(task => 
        task.status === 'backlog' || 
        task.status === 'qa team' || 
        task.status === 'in progress' ||
        task.status === 'done' ||
        task.status === 'Backlog' ||
        task.status === 'QA Team' ||
        task.status === 'In Progress' ||
        task.status === 'Done'
      );
      filteredTasks = filteredTasks.concat(taskBoardTasks);
      console.log(`Found ${taskBoardTasks.length} task board tasks`);
    }
    
    if (filters.archive) {
      const archiveTasks = tasks.filter(task => task.status === 'archive' || task.status === 'Archive');
      filteredTasks = filteredTasks.concat(archiveTasks);
      console.log(`Found ${archiveTasks.length} archive tasks`);
    }

    // Remove duplicates (in case a task matches multiple filters)
    const uniqueTasks = filteredTasks.filter((task, index, self) => 
      index === self.findIndex(t => t.id === task.id)
    );

    console.log(`Exporting ${uniqueTasks.length} unique tasks`);

    // Convert tasks to CSV format with specified columns
    const csvData = uniqueTasks.map(task => {
      // Combine site and path for Site URL
      const siteUrl = task.site_page ? 
        (task.site_page.startsWith('http') ? task.site_page : `https://${task.site_page}`) : '';
      
      return {
        'BugID': task.id || '',
        'Bug Status': 'New', // Hardcoded as requested
        'Bug Type': task.status || '',
        'Severity': task.priority || '',
        'Categories': task.tag_names ? task.tag_names.join(', ') : '',
        'Description': task.description || '',
        'Site URL': siteUrl,
        'OS': task.os || '',
        'Browser': task.browser || '',
        'Browser Size': task.browser_size || '',
        'Resolution': task.resolution || '',
        'Screenshot URL': task.screenshot || ''
      };
    });

    // Generate CSV content
    const csvHeaders = [
      'BugID',
      'Bug Status', 
      'Bug Type',
      'Severity',
      'Categories',
      'Description',
      'Site URL',
      'OS',
      'Browser',
      'Browser Size',
      'Resolution',
      'Screenshot URL'
    ];

    let csvContent = csvHeaders.join(',') + '\n';
    
    csvData.forEach(row => {
      const csvRow = csvHeaders.map(header => {
        const value = row[header] || '';
        // Escape commas and quotes in CSV values
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      });
      csvContent += csvRow.join(',') + '\n';
    });

    // Set response headers for CSV download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="bugherd_export_${projectId}_${new Date().toISOString().split('T')[0]}.csv"`);
    
    res.send(csvContent);

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