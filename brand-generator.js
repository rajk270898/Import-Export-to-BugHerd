const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
require('dotenv').config();

class BrandReportGenerator {
    constructor() {
        this.templatePath = path.join(__dirname, 'brand_Template', 'brand-template.html');
        this.outputPath = path.join(__dirname, 'generated-brand-report.html');
        this.apiBaseUrl = 'https://www.bugherd.com/api_v2';
        this.apiKey = process.env.BUGHERD_API_KEY;
        
        if (!this.apiKey) {
            console.error('Error: BUGHERD_API_KEY environment variable is not set');
            process.exit(1);
        }
    }

    async generateReport(projectId, filters = {}) {
        try {
            // Fetch project data
            const project = await this.fetchProject(projectId);
            if (!project) {
                throw new Error('Failed to fetch project data');
            }
            
            // Fetch tasks with filters
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
            
            // Generate the HTML report
            const html = await this.renderHtml(project, tasks);
            
            console.log('Brand report generated successfully');
            return html;
        } catch (error) {
            console.error('Error generating brand report:');
            console.error(error);
            throw error;
        }
    }

    async fetchProject(projectId) {
        console.log(`Fetching project ${projectId} from ${this.apiBaseUrl}`);
        try {
            const response = await axios.get(`${this.apiBaseUrl}/projects/${projectId}.json`, {
                auth: {
                    username: this.apiKey,
                    password: 'x'
                },
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                timeout: 10000
            });
            console.log('Project data received');
            
            // Log the full project data for debugging
            console.log('Project data from API:', JSON.stringify(response.data, null, 2));
            
            // Ensure the project has a site URL
            if (response.data && !response.data.site) {
                console.warn('No site URL found in project data. Falling back to tasks for site URL.');
            }
            
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
            const url = `${this.apiBaseUrl}/projects/${projectId}/tasks.json`;
            const allTasks = [];
            const perPage = 50;
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
                    timeout: 60000
                });
                
                let pageTasks = [];
                if (response.data?.tasks) {
                    pageTasks = response.data.tasks;
                } else if (Array.isArray(response.data)) {
                    pageTasks = response.data;
                }
                
                if (pageTasks.length === 0) {
                    hasMorePages = false;
                } else {
                    allTasks.push(...pageTasks);
                    currentPage++;
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            
            console.log(`Total tasks fetched: ${allTasks.length}`);
            return allTasks;
        } catch (error) {
            console.error('Error fetching tasks:', error.message);
            throw error;
        }
    }

    filterTasks(tasks, filters) {
        return tasks.filter(task => {
            // Implement your filtering logic here
            // Similar to the existing filter in generator.js
            return true; // Return true to include all tasks for now
        });
    }

    async renderHtml(project, tasks) {
        try {
            // Read the template file
            let html = await fs.promises.readFile(this.templatePath, 'utf8');
            
            // Get current date
            const currentDate = new Date().toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
    
            // Debug: Log the project object
            console.log('Project object:', JSON.stringify(project, null, 2));
            
            // Get site URL from project or tasks
            const siteUrl = project.site?.url || project.devurl || project.sites?.[0] || project.name || 'Project';
            let siteDisplay = siteUrl;
            let projectName = project.name || 'Project';
            
            // Clean up the site display URL
            try {
                if (siteDisplay) {
                    const url = new URL(siteDisplay.startsWith('http') ? siteDisplay : `https://${siteDisplay}`);
                    siteDisplay = url.hostname.replace(/^\./, '');
                }
            } catch (e) {
                siteDisplay = String(siteDisplay).replace(/^https?:\/\//, '').replace(/^\./, '');
            }
    
            // Prepare data for the template
            const findingsData = tasks.map(task => ({
                pageUrl: task.page_url || task.url || '',
                pageName: task.page_name || 'N/A',
                issueType: task.issue_type || 'N/A',
                description: task.description || 'No description',
                priority: task.priority || 'normal',
                status: task.status || 'new',
                screenshot: task.screenshot || 'View'
            }));
    
            console.log('Using siteDisplay:', siteDisplay);
            
            // Apply all replacements
            const replacements = {
                '{{projectName}}': projectName,
                '{{currentDate}}': currentDate,
                '{{totalIssues}}': tasks.length,
                '{{siteDisplay}}': siteDisplay,
                '{{siteUrl}}': siteUrl ? BrandReportGenerator.ensureProtocol(siteUrl) : '#',
                'findingsData: Array(42)': `findingsData: ${JSON.stringify(findingsData)}`,
                'auditLogData: Array(8)': `auditLogData: ${JSON.stringify(findingsData.slice(0, 8))}`
            };
    
            // Apply all replacements
            html = Object.entries(replacements).reduce(
                (result, [key, value]) => result.replace(new RegExp(BrandReportGenerator.escapeRegExp(key), 'g'), value),
                html
            );
    
            return html;
        } catch (error) {
            console.error('Error rendering HTML:', error);
            throw error;
        }
    }

    // Helper method to escape special regex characters
    static ensureProtocol(url) {
        if (!url) return url;
        return url.match(/^https?:\/\//) ? url : `https://${url}`;
    }

    static escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

// Export the class for use in other files
module.exports = BrandReportGenerator;
