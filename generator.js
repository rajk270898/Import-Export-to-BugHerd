const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
require('dotenv').config();

class ReportGenerator {
    constructor() {
        this.templatePath = path.join(__dirname, 'New template.html');
        this.outputPath = path.join(__dirname, 'generated-report.html');
        this.apiBaseUrl = 'https://www.bugherd.com/api_v2';
        this.apiKey = process.env.BUGHERD_API_KEY;
        
        if (!this.apiKey) {
            console.error('Error: BUGHERD_API_KEY environment variable is not set');
            process.exit(1);
        }
        
        console.log('ReportGenerator initialized with API URL:', this.apiBaseUrl);
    }

    async generateReport(projectId, filters = {}) {
        try {
            console.log('Starting report generation...');
            console.log('Project ID:', projectId);
            console.log('Filters:', JSON.stringify(filters, null, 2));
            
            // Step 1: Fetch project data
            console.log('Fetching project data...');
            const project = await this.fetchProject(projectId);
            if (!project) {
                throw new Error('Failed to fetch project data');
            }
            
            // Step 2: Fetch tasks with filters
            console.log('Fetching tasks with filters...');
            let tasks = await this.fetchTasks(projectId);
            
            // Apply filters if any
            if (Object.keys(filters).length > 0) {
                console.log('Applying filters to tasks...');
                tasks = this.filterTasks(tasks, filters);
            }
            
            if (tasks.length === 0) {
                console.warn('Warning: No tasks found matching the specified filters.');
            } else {
                console.log(`Found ${tasks.length} tasks after applying filters`);
            }
            
            // Step 3: Generate charts
            console.log('Generating charts...');
            const charts = await this.generateCharts(tasks);
            
            // Step 4: Render HTML
            console.log('Rendering HTML...');
            const html = await this.renderHtml(project, tasks, charts);
            
            // Step 5: Save the report
            console.log('Saving report...');
            await this.saveReport(html);
            
            console.log(`Report generated successfully: ${this.outputPath}`);
            return this.outputPath;
        } catch (error) {
            console.error('Error generating report:');
            
            if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
                console.error('Network error: Could not resolve the BugHerd API hostname.');
                console.error('Please check your internet connection and ensure you can access api.bugherd.com');
                console.error('You can test the connection by running:');
                console.error('  ping api.bugherd.com');
                console.error('or');
                console.error('  curl -v https://api.bugherd.com');
            } else if (error.response) {
                // The request was made and the server responded with a status code
                console.error(`API Error: ${error.response.status} - ${error.response.statusText}`);
                console.error('Response data:', error.response.data);
            } else if (error.request) {
                // The request was made but no response was received
                console.error('No response received from the BugHerd API.');
                console.error('This could be due to network issues or the API being unavailable.');
            } else {
                // Something happened in setting up the request
                console.error('Request setup error:', error.message);
            }
            
            console.error('\nTroubleshooting steps:');
            console.error('1. Check your internet connection');
            console.error('2. Verify api.bugherd.com is accessible from your network');
            console.error('3. Ensure your API key in .env is correct');
            console.error('4. Check if there are any network restrictions or proxy settings');
            
            process.exit(1);
        }
    }

    async fetchProject(projectId) {
        console.log(`Fetching project ${projectId} from ${this.apiBaseUrl}`);
        console.log('Using API Key:', this.apiKey ? '***' + this.apiKey.slice(-4) : 'Not set');
        try {
            const url = `${this.apiBaseUrl}/projects/${projectId}.json`;
            console.log('Making request to:', url);
            
            const response = await axios.get(url, {
                auth: {
                    username: this.apiKey,
                    password: 'x' // BugHerd requires any non-empty password
                },
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                // Add timeout and better error handling
                timeout: 10000,
                validateStatus: function (status) {
                    return status >= 200 && status < 500; // Resolve only if the status code is less than 500
                }
            });
            
            console.log('Project response status:', response.status);
            console.log('Project response headers:', JSON.stringify(response.headers, null, 2));
            
            if (response.status === 200) {
                console.log('Project data received:', JSON.stringify(response.data, null, 2));
                return response.data;
            } else if (response.status === 401) {
                console.error('Authentication failed. Please check your API key.');
                console.error('Response data:', response.data);
                throw new Error('Authentication failed. Please check your API key.');
            } else if (response.status === 404) {
                console.error(`Project ${projectId} not found. Please check the project ID.`);
                console.error('Response data:', response.data);
                throw new Error(`Project ${projectId} not found. Please check the project ID.`);
            } else {
                console.error('Unexpected response:', response.status, response.statusText);
                console.error('Response data:', response.data);
                throw new Error(`Unexpected response: ${response.status} ${response.statusText}`);
            }
        } catch (error) {
            console.error('Error fetching project:', error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response data:', error.response.data);
            }
            throw error;
        }
    }

    async fetchTasks(projectId) {
        console.log(`Fetching tasks for project ${projectId}`);
        console.log(`Using API Key: ${this.apiKey ? '***' + this.apiKey.slice(-4) : 'Not set'}`);
        
        // First, let's verify the project exists and we have access
        try {
            // Test the projects endpoint to verify access
            const projectsUrl = `${this.apiBaseUrl}/projects.json`;
            console.log(`Verifying API access by fetching projects list from: ${projectsUrl}`);
            
            const projectsResponse = await axios.get(projectsUrl, {
                auth: {
                    username: this.apiKey,
                    password: 'x'
                },
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                timeout: 10000,
                validateStatus: null // Don't throw on HTTP error status codes
            });
            
            console.log('Projects API response status:', projectsResponse.status);
            console.log('Projects API response headers:', JSON.stringify(projectsResponse.headers, null, 2));
            
            if (projectsResponse.status === 200) {
                console.log(`Successfully accessed projects API. Found ${projectsResponse.data.projects?.length || 0} projects.`);
                if (projectsResponse.data.projects?.length > 0) {
                    const projectExists = projectsResponse.data.projects.some(p => p.id == projectId);
                    console.log(`Project ${projectId} ${projectExists ? 'exists' : 'does not exist'} in the projects list.`);
                    if (!projectExists) {
                        console.log('Available project IDs:', projectsResponse.data.projects.map(p => p.id).join(', '));
                    }
                }
            } else {
                console.error('Failed to access projects API. Status:', projectsResponse.status);
                console.error('Response data:', projectsResponse.data);
                throw new Error(`Failed to verify project access. Status: ${projectsResponse.status}`);
            }
            
            // Now fetch all tasks with pagination
            console.log('Fetching all tasks with pagination...');
            const allTasks = [];
            let page = 1;
            const perPage = 100; // Maximum allowed by BugHerd API
            let hasMore = true;
            
            while (hasMore) {
                console.log(`Fetching page ${page} of tasks...`);
                try {
                    const response = await axios.get(`${this.apiBaseUrl}/projects/${projectId}/tasks.json`, {
                        params: {
                            page: page,
                            per_page: perPage,
                            include_archived: true,
                            include: 'attachments'
                        },
                        auth: {
                            username: this.apiKey,
                            password: 'x'
                        },
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json'
                        },
                        timeout: 15000,
                        validateStatus: null // Don't throw on HTTP error status codes
                    });
                    
                    console.log(`API Response Status: ${response.status}`);
                    
                    if (response.status === 200) {
                        const tasks = response.data.tasks || [];
                        console.log(`Found ${tasks.length} tasks in page ${page}`);
                        
                        if (tasks.length > 0) {
                            allTasks.push(...tasks);
                            console.log(`Total tasks collected so far: ${allTasks.length}`);
                            
                            // Check if we've reached the end of the results
                            const totalTasks = response.data.meta?.count || 0;
                            if (allTasks.length >= totalTasks) {
                                console.log(`Reached end of results (${allTasks.length}/${totalTasks} tasks)`);
                                hasMore = false;
                            } else {
                                page++;
                            }
                        } else {
                            console.log('No more tasks found');
                            hasMore = false;
                        }
                    } else {
                        console.error(`Error fetching tasks (Status: ${response.status}):`, response.data);
                        hasMore = false;
                    }
                } catch (error) {
                    console.error(`Error fetching page ${page}:`, error.message);
                    if (error.response) {
                        console.error('Response status:', error.response.status);
                        console.error('Response data:', error.response.data);
                    }
                    hasMore = false;
                }
                
                // Add a small delay between requests to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            console.log(`Total tasks fetched: ${allTasks.length}`);
            if (allTasks.length > 0) {
                console.log('Sample task:', JSON.stringify({
                    id: allTasks[0].id,
                    status: allTasks[0].status,
                    description: allTasks[0].description,
                    priority: allTasks[0].priority,
                    tags: allTasks[0].tags
                }, null, 2));
                
                // Return the fetched tasks
                return allTasks;
            } else {
                console.warn('No tasks found in the project.');
                return [];
            }
            
            while (hasMore) {
                console.log(`Fetching page ${page} of tasks...`);
                try {
                    const response = await axios.get(`${this.apiBaseUrl}/projects/${projectId}/tasks.json`, {
                        params: {
                            page: page,
                            per_page: perPage,
                            status: 'all',  // Include all statuses
                            include: 'attachments'  // Include attachments for screenshots
                        },
                        auth: {
                            username: this.apiKey,
                            password: 'x'
                        },
                        headers: {
                            'Accept': 'application/json'
                        },
                        timeout: 15000
                    });
                    
                    console.log(`API Response Status: ${response.status}`);
                    
                    // Handle different response formats
                    let tasks = [];
                    if (Array.isArray(response.data)) {
                        tasks = response.data;
                    } else if (response.data && response.data.tasks) {
                        tasks = Array.isArray(response.data.tasks) ? response.data.tasks : [response.data.tasks];
                    } else if (response.data) {
                        tasks = [response.data];
                    }
                    
                    console.log(`Found ${tasks.length} tasks in page ${page}`);
                    
                    if (tasks.length > 0) {
                        allTasks = allTasks.concat(tasks);
                        console.log(`Total tasks collected so far: ${allTasks.length}`);
                        
                        // Log first task details for debugging
                        if (page === 1 && tasks.length > 0) {
                            console.log('Sample task data:', JSON.stringify(tasks[0], null, 2));
                        }
                        
                        // Check if we should continue pagination
                        if (tasks.length < perPage) {
                            hasMore = false;
                        } else {
                            page++;
                            // Small delay to avoid hitting rate limits
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    } else {
                        // No more tasks
                        hasMore = false;
                    }
                } catch (error) {
                    console.error(`Error fetching page ${page}:`, error.message);
                    if (error.response) {
                        console.error('Response status:', error.response.status);
                        console.error('Response data:', error.response.data);
                    }
                    // Continue to next page even if one page fails
                    page++;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            
            console.log(`Total tasks fetched: ${allTasks.length}`);
            return allTasks;
            
        } catch (error) {
            console.error('Error in fetchTasks:', error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                if (error.response.data) {
                    console.error('Response data:', JSON.stringify(error.response.data, null, 2));
                }
            } else if (error.request) {
                console.error('No response received:', error.request);
            } else {
                console.error('Request setup error:', error.message);
            }
            throw error;
        }
    }
    
    /**
     * Filter tasks based on the provided filters
     * @param {Array} tasks - Array of tasks to filter
     * @param {Object} filters - Filters to apply
     * @returns {Array} Filtered array of tasks
     */
    filterTasks(tasks, filters = {}) {
        if (!tasks || !Array.isArray(tasks)) {
            console.warn('No tasks provided for filtering');
            return [];
        }

        console.log(`Filtering ${tasks.length} tasks with filters:`, JSON.stringify(filters, null, 2));
        
        const filteredTasks = tasks.filter(task => {
            if (!task) return false;
            
            // Debug: Log the first task to see its structure
            if (tasks.indexOf(task) === 0) {
                console.log('Sample task structure:', JSON.stringify(task, null, 2));
            }
            
            // Apply feedback filter
            if (filters.feedback !== undefined) {
                const isFeedback = task.task_type && 
                                 (task.task_type.name || '').toLowerCase().includes('feedback');
                
                if (filters.feedback !== isFeedback) {
                    return false;
                }
            }
            
            // Apply task board filter
            if (filters.taskBoard !== undefined) {
                const status = (task.status || task.status_name || '').toLowerCase();
                const isTaskBoard = [
                    'backlog', 'in progress', 'in-progress', 'in review', 'qa', 'testing',
                    'open', 'reopened', 'todo', 'to do', 'in development', 'dev', 'code review',
                    'qa team'  // Explicitly include QA Team status
                ].some(s => status.includes(s.toLowerCase()));
                
                // If taskBoard filter is true, include tasks that are not archived
                if (filters.taskBoard) {
                    const isArchived = [
                        'closed', 'resolved', 'completed', 'done', 'fixed', 'verified',
                        'wontfix', 'duplicate', 'invalid', 'rejected'
                    ].some(s => status.includes(s.toLowerCase()));
                    
                    if (isArchived) {
                        return false;
                    }
                    
                    // Include tasks that are either in task board statuses or have a column_id (indicating they're on the board)
                    if (!isTaskBoard && !task.column_id) {
                        return false;
                    }
                } else if (filters.taskBoard !== isTaskBoard) {
                    return false;
                }
            }
            
            // Apply archive filter
            if (filters.archive !== undefined) {
                const status = (task.status || task.status_name || '').toLowerCase();
                const isArchived = [
                    'closed', 'resolved', 'completed', 'done', 'fixed', 'verified',
                    'wontfix', 'duplicate', 'invalid', 'rejected'
                ].some(s => status.includes(s.toLowerCase()));
                
                if (filters.archive !== isArchived) {
                    return false;
                }
            }
            
            return true;
        });
        
        console.log(`Filtered tasks: ${filteredTasks.length} of ${tasks.length} tasks match the filters`);
        if (filteredTasks.length > 0) {
            console.log('First filtered task:', JSON.stringify(filteredTasks[0], null, 2));
        }
        
        return filteredTasks;
    }

    async generateCharts(tasks) {
        const width = 400;
        const height = 400;
        const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

        // Generate data for severity chart
        const severityData = this.getSeverityData(tasks);
        const severityConfig = this.getSeverityChartConfig(severityData);
        const severityChart = await chartJSNodeCanvas.renderToBuffer(severityConfig);

        // Generate data for status chart
        const statusData = this.getStatusData(tasks);
        const statusConfig = this.getStatusChartConfig(statusData);
        const statusChart = await chartJSNodeCanvas.renderToBuffer(statusConfig);

        return {
            severity: severityChart.toString('base64'),
            status: statusChart.toString('base64')
        };
    }

    getSeverityData(tasks) {
        const severityCounts = {
            critical: 0,
            major: 0,
            minor: 0,
            enhancement: 0
        };

        tasks.forEach(task => {
            const priority = (task.priority || '').toLowerCase();
            if (severityCounts.hasOwnProperty(priority)) {
                severityCounts[priority]++;
            } else {
                severityCounts.minor++; // Default to minor if priority not recognized
            }
        });

        return {
            labels: ['Critical', 'Major', 'Minor', 'Enhancement'],
            data: Object.values(severityCounts),
            colors: ['#EF4444', '#F59E0B', '#10B981', '#3B82F6']
        };
    }

    getStatusData(tasks) {
        const statusMap = {};
        
        tasks.forEach(task => {
            const status = task.status?.name || 'Unknown';
            statusMap[status] = (statusMap[status] || 0) + 1;
        });

        return {
            labels: Object.keys(statusMap),
            data: Object.values(statusMap),
            colors: this.generateColors(Object.keys(statusMap).length)
        };
    }

    generateColors(count) {
        const colors = [];
        const hueStep = 360 / count;
        
        for (let i = 0; i < count; i++) {
            const hue = (i * hueStep) % 360;
            colors.push(`hsl(${hue}, 70%, 60%)`);
        }
        
        return colors;
    }

    getSeverityChartConfig(data) {
        return {
            type: 'doughnut',
            data: {
                labels: data.labels,
                datasets: [{
                    data: data.data,
                    backgroundColor: data.colors,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            font: {
                                family: 'Outfit, sans-serif'
                            }
                        }
                    }
                },
                cutout: '70%'
            }
        };
    }

    getStatusChartConfig(data) {
        return {
            type: 'pie',
            data: {
                labels: data.labels,
                datasets: [{
                    data: data.data,
                    backgroundColor: data.colors,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                cutout: '60%'
            }
        };
    }

    async renderHtml(project, tasks, charts) {
        console.log('Rendering HTML with project:', project.name);
        console.log('Number of tasks to render:', tasks.length);
        
        // Read the template file
        let html = fs.readFileSync(this.templatePath, 'utf8');
        
        // Update the title with project name
        html = html.replace('Bug Report', `Bug Report - ${project.name}`);
        
        // Convert tasks to the format expected by the template
        const bugData = tasks.map((task, index) => {
            const severity = this.mapPriorityToSeverity(task.priority);
            console.log(`Task ${index + 1}:`, {
                id: task.id || index + 1,
                status: task.status?.name || 'New',
                type: task.task_type || 'Bug',
                severity: severity,
                siteUrl: task.site_url || 'No URL provided',
                description: task.description || 'No description provided'
            });
            
            return {
                id: task.id || index + 1,
                status: task.status?.name || 'New',
                type: task.task_type || 'Bug',
                severity: severity,
                tags: Array.isArray(task.tags) ? task.tags : [],
                description: task.description || 'No description provided',
                siteUrl: task.site_url || 'No URL provided',
                os: task.os || 'Unknown',
                browser: task.browser || 'Unknown',
                browserSize: task.browser_size || 'Unknown',
                resolution: task.resolution || 'Unknown',
                screenshotUrl: task.screenshot_url || '',
                email: task.requester_email || 'No email provided',
                // Add any additional fields that might be needed
                // createdAt: task.created_at || new Date().toISOString(),
                // updatedAt: task.updated_at || new Date().toISOString()
            };
        });
        
        console.log('Converted bug data sample:', JSON.stringify(bugData[0], null, 2));
        
        // Create a script tag with the bug data
        const bugDataScript = `
        <script>
            // Initialize bug data - Injected by ReportGenerator
            (function() {
                console.log('Injecting bug data...');
                window.bugData = ${JSON.stringify(bugData, null, 4)};
                console.log('Bug data injected. Total bugs:', window.bugData ? window.bugData.length : 0);
                if (window.bugData && window.bugData.length > 0) {
                    console.log('Sample bug:', JSON.stringify(window.bugData[0]));
                }
                
                // Dispatch an event when data is loaded
                const event = new CustomEvent('bugDataLoaded', {
                    detail: { count: window.bugData ? window.bugData.length : 0 }
                });
                document.dispatchEvent(event);
                
                // Also set a flag on the document
                document.documentElement.setAttribute('data-bugdata-loaded', 'true');
                
                // Initialize the app if it exists
                if (typeof initializeApp === 'function') {
                    console.log('Initializing app from data injection...');
                    initializeApp();
                }
            })();
        </script>`;
        
        // Make sure we're replacing the right part of the template
        html = html.replace(/\/\/ Initialize bug data[\s\S]*?window\.bugData = \[[\s\S]*?\];/, bugDataScript);
        
        // Add debug script to log when the page loads
        const debugScript = `
            <script>
                console.log('Template loaded with', window.bugData ? window.bugData.length : 0, 'bugs');
                console.log('Sample bug:', window.bugData ? window.bugData[0] : 'No data');
            </script>
        `;
        html = html.replace('</body>', `${debugScript}\n    </body>`);
        
        return html;
    }
    
    mapPriorityToSeverity(priority) {
        if (!priority) return 'Not Set';
        const priorityMap = {
            'critical': 'Critical',
            'high': 'Important',
            'medium': 'Normal',
            'low': 'Minor'
        };
        return priorityMap[priority.toLowerCase()] || 'Not Set';
    }

    generateTasksHtml(tasks) {
        return tasks.map(task => `
            <div class="issue-card" data-severity="${task.priority?.toLowerCase() || 'minor'}" 
                 data-status="${task.status?.name?.toLowerCase() || 'open'}">
                <div class="issue-header">
                    <span class="issue-id">#${task.id}</span>
                    <span class="issue-priority ${task.priority?.toLowerCase() || 'minor'}">
                        ${task.priority || 'Minor'}
                    </span>
                </div>
                <div class="issue-description">
                    ${task.description || 'No description provided'}
                </div>
                <div class="issue-footer">
                    <span class="issue-status">${task.status?.name || 'Open'}</span>
                    <span class="issue-date">${new Date(task.created_at).toLocaleDateString()}</span>
                </div>
            </div>
        `).join('\n');
    }

    generateSummary(tasks) {
        const total = tasks.length;
        const bySeverity = tasks.reduce((acc, task) => {
            const severity = task.priority?.toLowerCase() || 'minor';
            acc[severity] = (acc[severity] || 0) + 1;
            return acc;
        }, {});

        const byStatus = tasks.reduce((acc, task) => {
            const status = task.status?.name || 'Open';
            acc[status] = (acc[status] || 0) + 1;
            return acc;
        }, {});

        return {
            total,
            bySeverity,
            byStatus
        };
    }

    injectSummary(html, summary) {
        // Update total count
        html = html.replace('<!-- TOTAL_ISSUES -->', summary.total);
        
        // Update severity counts
        Object.entries(summary.bySeverity).forEach(([severity, count]) => {
            html = html.replace(`<!-- ${severity.toUpperCase()}_COUNT -->`, count);
        });
        
        // Update status counts
        let statusHtml = '';
        Object.entries(summary.byStatus).forEach(([status, count]) => {
            statusHtml += `
                <div class="status-item">
                    <span class="status-name">${status}:</span>
                    <span class="status-count">${count}</span>
                </div>
            `;
        });
        
        return html.replace('<!-- STATUS_ITEMS -->', statusHtml);
    }

    async saveReport(html) {
        return new Promise((resolve, reject) => {
            fs.writeFile(this.outputPath, html, 'utf8', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

// Export the class for use in other files
module.exports = ReportGenerator;

// If this file is run directly, execute the report generation
if (require.main === module) {
    const projectId = process.argv[2];
    if (!projectId) {
        console.error('Usage: node generator.js <project-id>');
        process.exit(1);
    }
    
    const generator = new ReportGenerator();
    generator.generateReport(projectId);
}
