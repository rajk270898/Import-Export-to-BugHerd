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
        
    }

    async generateReport(projectId, filters = {}) {
        try {
            
            // Step 1: Fetch project data
            const project = await this.fetchProject(projectId);
            if (!project) {
                throw new Error('Failed to fetch project data');
            }
            
            // Step 2: Fetch tasks with filters
            let tasks = await this.fetchTasks(projectId);
            
            // Apply filters if any
            if (Object.keys(filters).length > 0) {
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
        try {
            const response = await axios.get(`${this.apiBaseUrl}/projects/${projectId}.json`, {
                auth: {
                    username: this.apiKey,
                    password: 'x' // BugHerd requires a non-empty password
                },
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                timeout: 10000 // 10 seconds timeout
            });
            console.log('Project data received');
            return response.data.project;
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
        
        try {
            console.log('Trying API with Basic Auth...');
            const url = `${this.apiBaseUrl}/projects/${projectId}/tasks.json`;
            
            console.log('Request URL:', url);
            
            // First, try to get project info to verify the project exists
            try {
                console.log('Fetching project info...');
                const projectUrl = `${this.apiBaseUrl}/projects/${projectId}.json`;
                const projectResponse = await axios.get(projectUrl, {
                    auth: {
                        username: this.apiKey,
                        password: 'x'
                    },
                    headers: {
                        'Accept': 'application/json'
                    },
                    timeout: 10000
                });
                console.log('Project info:', {
                    id: projectResponse.data?.project?.id,
                    name: projectResponse.data?.project?.name,
                    tasks_count: projectResponse.data?.project?.tasks_count
                });
            } catch (projectError) {
                console.error('Failed to fetch project info:', projectError.message);
                if (projectError.response) {
                    console.error('Response status:', projectError.response.status);
                    console.error('Response data:', projectError.response.data);
                }
                throw new Error('Failed to verify project');
            }

            // Now fetch all tasks with pagination, matching the CSV export approach
            console.log('Fetching tasks with pagination...');
            const allTasks = [];
            const perPage = 100;
            let currentPage = 1;
            let hasMorePages = true;
            
            while (hasMorePages) {
                console.log(`Fetching page ${currentPage}...`);
                const response = await axios.get(url, {
                    params: {
                        include: 'attachments',
                        per_page: perPage,
                        page: currentPage
                    },
                    auth: {
                        username: this.apiKey,
                        password: 'x'
                    },
                    headers: {
                        'Accept': 'application/json'
                    },
                    timeout: 30000
                });
                
                console.log(`Page ${currentPage} response status:`, response.status);
                
                let pageTasks = [];
                if (response.data?.tasks) {
                    pageTasks = response.data.tasks;
                } else if (Array.isArray(response.data)) {
                    pageTasks = response.data;
                }
                
                console.log(`Found ${pageTasks.length} tasks on page ${currentPage}`);
                allTasks.push(...pageTasks);
                
                if (pageTasks.length < perPage) {
                    hasMorePages = false;
                } else {
                    currentPage++;
                    // Small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
            
            console.log(`Total tasks fetched: ${allTasks.length}`);
            if (allTasks.length === 0) {
                console.log('No tasks found in the response.');
                
                // Try a direct API call for debugging
                try {
                    const directUrl = `https://www.bugherd.com/api_v2/projects/${projectId}/tasks.json?key=${this.apiKey}`;
                    console.log('Attempting direct API call for debugging...');
                    console.log('Direct URL:', directUrl);
                    
                    const directResponse = await axios.get(directUrl, {
                        headers: {
                            'Accept': 'application/json'
                        },
                        timeout: 10000
                    });
                    
                    console.log('Direct API response:', {
                        status: directResponse.status,
                        statusText: directResponse.statusText,
                        data: directResponse.data ? 'Data received' : 'No data',
                        tasksCount: directResponse.data?.tasks?.length || 0
                    });
                } catch (directError) {
                    console.error('Direct API call failed:', directError.message);
                }
            }
            
            return allTasks;
            
        } catch (error) {
            console.error('Error in fetchTasks:', error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response headers:', error.response.headers);
                if (error.response.data) {
                    console.error('Response data:', JSON.stringify(error.response.data, null, 2));
                }
            } else if (error.request) {
                console.error('No response received. This could be due to:');
                console.error('1. Network connectivity issues');
                console.error('2. CORS restrictions');
                console.error('3. Server not responding');
                console.error('Request details:', error.request);
            } else {
                console.error('Request setup error:', error.message);
            }
            
            // Return empty array instead of throwing to allow the report to be generated
            return [];
        }
    }
    
    /**
     * Filter tasks based on the provided filters
     * @param {Array} tasks - Array of tasks to filter
     * @param {Object} filters - Filters to apply
     * @returns {Array} Filtered array of tasks
     */
    filterTasks(tasks, filters) {
        if (!tasks || !Array.isArray(tasks)) {
            console.warn('No tasks provided for filtering');
            return [];
        }

        console.log(`Filtering ${tasks.length} tasks with filters:`, JSON.stringify(filters, null, 2));
        
        const filtered = tasks.filter(task => {
            // Debug log for each task
            console.log('\nProcessing task:', {
                id: task.id,
                status: task.status,
                column_id: task.column_id,
                description: task.description?.substring(0, 50) + '...',
                priority_id: task.priority_id
            });

            // Get the task status (use status.name if available, otherwise status)
            const status = task.status?.name || task.status || '';
            const isArchived = status.toLowerCase() === 'closed' || status.toLowerCase() === 'resolved';
            
            // Debug log filters
            console.log(`- Status: ${status}, isArchived: ${isArchived}`);
            
            // Apply archive filter
            if (filters.archive !== undefined) {
                if (filters.archive && !isArchived) {
                    console.log('- Filtered out: Task is not archived but archive filter is true');
                    return false;
                }
                if (!filters.archive && isArchived) {
                    console.log('- Filtered out: Task is archived but archive filter is false');
                    return false;
                }
            }
            
            // For task board filter, we'll check if the task has a column_id
            if (filters.taskBoard !== undefined) {
                console.log(`- Task has column_id: ${!!task.column_id}, taskBoard filter: ${filters.taskBoard}`);
                if (filters.taskBoard && !task.column_id) {
                    console.log('- Filtered out: Task has no column_id but taskBoard filter is true');
                    return false;
                }
                if (!filters.taskBoard && task.column_id) {
                    console.log('- Filtered out: Task has column_id but taskBoard filter is false');
                    return false;
                }
            }
            
            console.log('- Task passed all filters');
            return true;
        });

        console.log(`Filtering complete. ${filtered.length} of ${tasks.length} tasks passed the filters.`);
        return filtered;
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
        // Read the template file
        let html = fs.readFileSync(this.templatePath, 'utf8');
        
        // Format the current date
        const currentDate = new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        // Prepare bug data with all required fields matching the CSV export format
        const bugData = tasks.map((task, index) => {
            // Helper function to safely get values
            const getValue = (value, defaultValue = '') => {
                if (value === null || value === undefined) return defaultValue;
                if (Array.isArray(value)) return value.join(', ');
                return String(value).trim() || defaultValue;
            };

            // Extract status and type
            const status = getValue(task.status?.name || task.status);
            const bugType = status && status.toLowerCase() === 'suggestion' ? 'Suggestion' : 
                          (status && status.toLowerCase() === 'qa team' ? 'Bug' : status);
            
            // Extract priority
            const priorityMap = {
                1: 'Critical',
                2: 'Important',
                3: 'Normal',
                4: 'Minor',
                0: 'Not Set'
            };
            const priority = task.priority_id !== undefined ? 
                priorityMap[task.priority_id] || 'Normal' : 'Normal';
            
            // Extract description and environment info
            const description = getValue(task.description);
            const env = this.extractEnvFromDescription(description);
            
            // Extract tags
            const tags = task.tag_names ? 
                (Array.isArray(task.tag_names) ? task.tag_names.join(', ') : task.tag_names) : 
                (task.tags ? (Array.isArray(task.tags) ? task.tags.join(', ') : task.tags) : '');
            
            // Extract URL - check multiple possible fields
            let siteUrl = '';
            if (task.site) siteUrl = task.site;
            else if (task.url) siteUrl = task.url;
            else if (task.site_page) siteUrl = task.site_page;
            else if (task.site_url) siteUrl = task.site_url;
            
            // Extract screenshot URL
            let screenshot = '';
            if (task.screenshot_url) screenshot = task.screenshot_url;
            else if (task.screenshot) screenshot = task.screenshot;
            else if (task.attachments && task.attachments.length > 0) {
                // Try to get the first image attachment
                const imageAttachment = task.attachments.find(att => 
                    att.content_type && att.content_type.startsWith('image/')
                );
                if (imageAttachment) {
                    screenshot = imageAttachment.url || '';
                }
            }
            
            // Extract reporter/requester
            const reporter = getValue(task.requester_email || task.reporter);
            
            // Return data in the same format as CSV export
            return {
                id: index + 1, // BugID is 1-based index
                bugStatus: 'New',
                bugType: bugType,
                priority: priority,
                priorityId: task.priority_id || '',
                description: description,
                tags: tags,
                siteUrl: siteUrl,
                os: env.os,
                browser: env.browser,
                browserSize: env.browserWindow,
                resolution: env.resolution,
                screenshot: screenshot,
                reporter: reporter,
                severity: priority, // Using same as priority for now
                tagsCategories: tags, // Same as tags for now
                element: 'Not specified',
                assignee: task.assignee_email || 'Unassigned',
                comments: task.comments_count || 0,
                
                // Keep original fields for backward compatibility
                title: `Task ${index + 1}`,
                status: status,
                created_at: task.created_at || new Date().toISOString(),
                updated_at: task.updated_at || new Date().toISOString()
            };
        });

        // Debug: Log the first task to verify the structure
        if (bugData.length > 0) {
            console.log('First task data:', JSON.stringify(bugData[0], null, 2));
        }

        // Inject the bug data as a JavaScript variable
        const bugDataScript = `
            <script>
                // Store the tasks data in a global variable
                window.bugData = ${JSON.stringify(bugData, null, 2)};
                
                // Debug: Log the data to console
                console.log('Bug data loaded:', window.bugData);
            </script>
        `;
        
        // Inject the bug data script before the closing head tag
        html = html.replace('</head>', `${bugDataScript}</head>`);
        
        // Update the report title with project name and date
        const reportTitle = `Bug Report - ${project.name || 'Project'} - ${currentDate}`;
        html = html.replace('<title>Sample Font Style Report</title>', `<title>${reportTitle}</title>`);
        
        // Update the report title in the header
        const reportTitleRegex = /<span\s+class=["']report-title["']>.*?<\/span>/i;
        html = html.replace(reportTitleRegex, `<span class="report-title">${reportTitle}</span>`);
        
        // Prepare the charts initialization script
        const chartsScript = `
            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    // Initialize the UI with the new template's functions
                    if (window.bugData && window.bugData.length > 0) {
                        // Initialize the charts
                        const severityCtx = document.getElementById('severityChart').getContext('2d');
                        window.severityChart = new Chart(severityCtx, {
                            type: 'pie',
                            data: {
                                labels: ['Critical', 'Important', 'Normal', 'Minor', 'Not Set'],
                                datasets: [{
                                    data: [
                                        window.bugData.filter(b => b.priority === 'critical').length,
                                        window.bugData.filter(b => b.priority === 'important').length,
                                        window.bugData.filter(b => b.priority === 'normal').length,
                                        window.bugData.filter(b => b.priority === 'minor').length,
                                        window.bugData.filter(b => !b.priority || b.priority === 'not set').length
                                    ],
                                    backgroundColor: [
                                        '#EF4444', // Critical - Red
                                        '#F59E0B', // Important - Amber
                                        '#3B82F6', // Normal - Blue
                                        '#6B7280', // Minor - Gray
                                        '#E5E7EB'  // Not Set - Light Gray
                                    ],
                                    borderWidth: 0
                                }]
                            },
                            options: {
                                responsive: true,
                                maintainAspectRatio: false,
                                plugins: {
                                    legend: {
                                        position: 'bottom',
                                        labels: {
                                            font: {
                                                family: 'Outfit, sans-serif'
                                            },
                                            padding: 20
                                        }
                                    }
                                },
                                cutout: '70%',
                                onClick: function(evt, elements) {
                                    if (elements.length > 0) {
                                        const index = elements[0].index;
                                        const labels = this.data.labels;
                                        const severity = labels[index].toLowerCase();
                                        if (typeof filterIssues === 'function') {
                                            filterIssues(severity === 'not set' ? '' : severity);
                                        }
                                    }
                                }
                            }
                        });

                        // Initialize the UI components
                        if (typeof createIssueCards === 'function') {
                            createIssueCards();
                        }
                        
                        if (typeof initializeAccordion === 'function') {
                            initializeAccordion();
                        }
                        
                        // Show critical issues by default if the function exists
                        if (typeof filterIssues === 'function') {
                            filterIssues('critical');
                            
                            // Update the UI to show the critical filter as active
                            const criticalFilter = document.querySelector('.property-item');
                            if (criticalFilter) {
                                criticalFilter.classList.add('selected');
                            }
                        }
                    } else {
                        // No bugs case
                        const issueList = document.querySelector('.issue-list');
                        if (issueList) {
                            const noIssuesDiv = document.createElement('div');
                            noIssuesDiv.className = 'no-issues';
                            
                            const heading = document.createElement('h3');
                            heading.textContent = 'No issues found';
                            
                            const paragraph = document.createElement('p');
                            paragraph.textContent = 'There are no issues to display for the selected filters.';
                            
                            noIssuesDiv.appendChild(heading);
                            noIssuesDiv.appendChild(paragraph);
                            
                            issueList.innerHTML = '';
                            issueList.appendChild(noIssuesDiv);
                        }
                    }
                });
            </script>
        `;
        
        // Inject the charts script before the closing body tag
        return html.replace('</body>', `${chartsScript}</body>`);
    }
    
    generateTasksHtml(tasks) {
        return tasks.map((task, index) => {
            // Helper function to safely get values
            const getValue = (value, defaultValue = '') => {
                if (value === null || value === undefined) return defaultValue;
                if (Array.isArray(value)) return value.join(', ');
                if (typeof value === 'object') return JSON.stringify(value);
                return String(value).trim();
            };

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

            // Get status with fallback
            const status = task.status?.name || task.status || 'Open';
            
            // Format description with line breaks
            const description = getValue(task.description).replace(/\n/g, '<br>');
            
            // Extract environment information
            const env = this.extractEnvFromDescription(description);
            
            // Get site URL with fallbacks
            const siteUrl = getValue(
                task.url || 
                task.site_url || 
                task.page_url || 
                task.site || 
                task.page || 
                task.site_page ||
                task.URL ||
                task['page-url'] ||
                task['site-page'] ||
                task['site_page'] ||
                (task.attributes && (task.attributes.url || task.attributes.page_url || task.attributes.site_url))
            );
            
            // Get screenshot URL
            const screenshot = task.screenshot_url || 
                             (task.attachments && task.attachments.length > 0 ? task.attachments[0].url : '');
            
            // Get requester email
            const requesterEmail = task.requester_email || 
                                 (task.requester && task.requester.email) || 
                                 (task.reporter && (task.reporter.email || task.reporter.name)) || 
                                 '';
            
            // Format tags
            const tags = Array.isArray(task.tags) 
                ? task.tags.map(tag => typeof tag === 'string' ? tag : tag.name).join(', ')
                : getValue(task.tags);
                
            // Determine bug type based on status
            const bugType = status && status.toLowerCase() === 'suggestion' 
                ? 'Suggestion' 
                : (status && status.toLowerCase() === 'qa team' ? 'Bug' : status);

            // Create data object with only the required fields
            const taskData = {
                'BugID': (index + 1),
                'Bug Status': 'New',
                'Bug Type': (status && status.toLowerCase() === 'suggestion' ? 'Suggestion' : (status && status.toLowerCase() === 'qa team' ? 'Bug' : status)),
                'Priority': priority,
                'Priority ID': task.priority_id || '',
                'Description': description.replace(/<br\s*\/?>/g, '\n'), // Convert <br> back to newlines for display
                'Tags': tags,
                'Site URL': siteUrl,
                'OS': env.os,
                'Browser': env.browser,
                'Browser Size': env.browserWindow,
                'Resolution': env.resolution,
                'Screenshot URL': screenshot,
                'Reporter': requesterEmail,
                'Severity': priority,
                'Tags/Categories': tags
            };

            // Generate HTML for the task card
            return `
                <div class="issue-card" 
                     data-severity="${priority}" 
                     data-status="${status.toLowerCase()}"
                     data-id="${task.id || ''}">
                    <div class="issue-header">
                        <span class="issue-id">#${taskData['BugID']}</span>
                        <span class="issue-priority ${priority}">
                            ${priority.charAt(0).toUpperCase() + priority.slice(1)}
                        </span>
                    </div>
                    <div class="issue-description">
                        <strong>Bug Type:</strong> ${taskData['Bug Type']}<br>
                        <strong>Status:</strong> ${taskData['Bug Status']}<br>
                        <strong>Priority:</strong> ${taskData['Priority']} (ID: ${taskData['Priority ID']})<br>
                        <strong>Severity:</strong> ${taskData['Severity']}<br>
                        <strong>Description:</strong> ${taskData['Description'].replace(/\n/g, '<br>')}<br><br>
                        
                        <strong>Environment:</strong>
                        <ul>
                            <li>Site URL: ${taskData['Site URL'] || 'N/A'}</li>
                            <li>OS: ${taskData['OS'] || 'N/A'}</li>
                            <li>Browser: ${taskData['Browser'] || 'N/A'}</li>
                            <li>Browser Size: ${taskData['Browser Size'] || 'N/A'}</li>
                            <li>Resolution: ${taskData['Resolution'] || 'N/A'}</li>
                        </ul>
                        
                        ${taskData['Screenshot URL'] ? 
                            `<strong>Screenshot:</strong> <a href="${taskData['Screenshot URL']}" target="_blank">View Screenshot</a><br>` : ''}
                        
                        <strong>Reporter:</strong> ${taskData['Reporter'] || 'N/A'}<br>
                        <strong>Tags:</strong> ${taskData['Tags'] || 'None'}<br>
                    </div>
                </div>
            `;
        }).join('\n');
    }

    extractEnvFromDescription(desc) {
        if (typeof desc !== 'string') return { os: '', browser: '', resolution: '', browserWindow: '' };
        
        const osMatch = desc.match(/OS\s*:\s*([^\n]+)/i);
        const browserMatch = desc.match(/Browser\s*:\s*([^\n]+)/i);
        const resMatch = desc.match(/Resolution\s*:?\s*([^\n]+)/i);
        const browserWindowMatch = desc.match(/Browser\s*Window\s*:?\s*([^\n]+)/i);
        
        return {
            os: osMatch ? osMatch[1].trim() : '',
            browser: browserMatch ? browserMatch[1].trim() : '',
            resolution: resMatch ? resMatch[1].trim() : '',
            browserWindow: browserWindowMatch ? browserWindowMatch[1].trim() : ''
        };
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
