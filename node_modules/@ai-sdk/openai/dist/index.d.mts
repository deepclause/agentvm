import * as _ai_sdk_provider from '@ai-sdk/provider';
import { ProviderV3, LanguageModelV3, EmbeddingModelV3, ImageModelV3, TranscriptionModelV3, SpeechModelV3 } from '@ai-sdk/provider';
import * as _ai_sdk_provider_utils from '@ai-sdk/provider-utils';
import { InferSchema, FetchFunction } from '@ai-sdk/provider-utils';

type OpenAIChatModelId = 'o1' | 'o1-2024-12-17' | 'o3-mini' | 'o3-mini-2025-01-31' | 'o3' | 'o3-2025-04-16' | 'gpt-4.1' | 'gpt-4.1-2025-04-14' | 'gpt-4.1-mini' | 'gpt-4.1-mini-2025-04-14' | 'gpt-4.1-nano' | 'gpt-4.1-nano-2025-04-14' | 'gpt-4o' | 'gpt-4o-2024-05-13' | 'gpt-4o-2024-08-06' | 'gpt-4o-2024-11-20' | 'gpt-4o-mini' | 'gpt-4o-mini-2024-07-18' | 'gpt-4-turbo' | 'gpt-4-turbo-2024-04-09' | 'gpt-4' | 'gpt-4-0613' | 'gpt-4.5-preview' | 'gpt-4.5-preview-2025-02-27' | 'gpt-3.5-turbo-0125' | 'gpt-3.5-turbo' | 'gpt-3.5-turbo-1106' | 'chatgpt-4o-latest' | 'gpt-5' | 'gpt-5-2025-08-07' | 'gpt-5-mini' | 'gpt-5-mini-2025-08-07' | 'gpt-5-nano' | 'gpt-5-nano-2025-08-07' | 'gpt-5-chat-latest' | 'gpt-5.1' | 'gpt-5.1-chat-latest' | 'gpt-5.2' | 'gpt-5.2-chat-latest' | 'gpt-5.2-pro' | (string & {});
declare const openaiChatLanguageModelOptions: _ai_sdk_provider_utils.LazySchema<{
    logitBias?: Record<number, number> | undefined;
    logprobs?: number | boolean | undefined;
    parallelToolCalls?: boolean | undefined;
    user?: string | undefined;
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
    maxCompletionTokens?: number | undefined;
    store?: boolean | undefined;
    metadata?: Record<string, string> | undefined;
    prediction?: Record<string, any> | undefined;
    serviceTier?: "default" | "auto" | "flex" | "priority" | undefined;
    strictJsonSchema?: boolean | undefined;
    textVerbosity?: "low" | "medium" | "high" | undefined;
    promptCacheKey?: string | undefined;
    promptCacheRetention?: "in_memory" | "24h" | undefined;
    safetyIdentifier?: string | undefined;
    systemMessageMode?: "remove" | "system" | "developer" | undefined;
    forceReasoning?: boolean | undefined;
}>;
type OpenAIChatLanguageModelOptions = InferSchema<typeof openaiChatLanguageModelOptions>;

type OpenAICompletionModelId = 'gpt-3.5-turbo-instruct' | (string & {});

type OpenAIEmbeddingModelId = 'text-embedding-3-small' | 'text-embedding-3-large' | 'text-embedding-ada-002' | (string & {});

type OpenAIImageModelId = 'dall-e-3' | 'dall-e-2' | 'gpt-image-1' | 'gpt-image-1-mini' | 'gpt-image-1.5' | (string & {});

declare const webSearchToolFactory: _ai_sdk_provider_utils.ProviderToolFactoryWithOutputSchema<{}, {
    /**
     * An object describing the specific action taken in this web search call.
     * Includes details on how the model used the web (search, open_page, find_in_page).
     */
    action: {
        /**
         * Action type "search" - Performs a web search query.
         */
        type: "search";
        /**
         * The search query.
         */
        query?: string;
    } | {
        /**
         * Action type "openPage" - Opens a specific URL from search results.
         */
        type: "openPage";
        /**
         * The URL opened by the model.
         */
        url?: string | null;
    } | {
        /**
         * Action type "findInPage": Searches for a pattern within a loaded page.
         */
        type: "findInPage";
        /**
         * The URL of the page searched for the pattern.
         */
        url?: string | null;
        /**
         * The pattern or text to search for within the page.
         */
        pattern?: string | null;
    };
    /**
     * Optional sources cited by the model for the web search call.
     */
    sources?: Array<{
        type: "url";
        url: string;
    } | {
        type: "api";
        name: string;
    }>;
}, {
    /**
     * Whether to use external web access for fetching live content.
     * - true: Fetch live web content (default)
     * - false: Use cached/indexed results
     */
    externalWebAccess?: boolean;
    /**
     * Filters for the search.
     */
    filters?: {
        /**
         * Allowed domains for the search.
         * If not provided, all domains are allowed.
         * Subdomains of the provided domains are allowed as well.
         */
        allowedDomains?: string[];
    };
    /**
     * Search context size to use for the web search.
     * - high: Most comprehensive context, highest cost, slower response
     * - medium: Balanced context, cost, and latency (default)
     * - low: Least context, lowest cost, fastest response
     */
    searchContextSize?: "low" | "medium" | "high";
    /**
     * User location information to provide geographically relevant search results.
     */
    userLocation?: {
        /**
         * Type of location (always 'approximate')
         */
        type: "approximate";
        /**
         * Two-letter ISO country code (e.g., 'US', 'GB')
         */
        country?: string;
        /**
         * City name (free text, e.g., 'Minneapolis')
         */
        city?: string;
        /**
         * Region name (free text, e.g., 'Minnesota')
         */
        region?: string;
        /**
         * IANA timezone (e.g., 'America/Chicago')
         */
        timezone?: string;
    };
}>;

/**
 * A filter used to compare a specified attribute key to a given value using a defined comparison operation.
 */
type OpenAIResponsesFileSearchToolComparisonFilter = {
    /**
     * The key to compare against the value.
     */
    key: string;
    /**
     * Specifies the comparison operator: eq, ne, gt, gte, lt, lte, in, nin.
     */
    type: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin';
    /**
     * The value to compare against the attribute key; supports string, number, boolean, or array of string types.
     */
    value: string | number | boolean | string[];
};
/**
 * Combine multiple filters using and or or.
 */
type OpenAIResponsesFileSearchToolCompoundFilter = {
    /**
     * Type of operation: and or or.
     */
    type: 'and' | 'or';
    /**
     * Array of filters to combine. Items can be ComparisonFilter or CompoundFilter.
     */
    filters: Array<OpenAIResponsesFileSearchToolComparisonFilter | OpenAIResponsesFileSearchToolCompoundFilter>;
};
declare const openaiResponsesChunkSchema: _ai_sdk_provider_utils.LazySchema<{
    type: "unknown_chunk";
    message: string;
} | {
    type: "response.output_text.delta";
    item_id: string;
    delta: string;
    logprobs?: {
        token: string;
        logprob: number;
        top_logprobs: {
            token: string;
            logprob: number;
        }[];
    }[] | null | undefined;
} | {
    type: "response.completed" | "response.incomplete";
    response: {
        usage: {
            input_tokens: number;
            output_tokens: number;
            input_tokens_details?: {
                cached_tokens?: number | null | undefined;
            } | null | undefined;
            output_tokens_details?: {
                reasoning_tokens?: number | null | undefined;
            } | null | undefined;
        };
        incomplete_details?: {
            reason: string;
        } | null | undefined;
        service_tier?: string | null | undefined;
    };
} | {
    type: "response.created";
    response: {
        id: string;
        created_at: number;
        model: string;
        service_tier?: string | null | undefined;
    };
} | {
    type: "response.output_item.added";
    output_index: number;
    item: {
        type: "message";
        id: string;
    } | {
        type: "reasoning";
        id: string;
        encrypted_content?: string | null | undefined;
    } | {
        type: "function_call";
        id: string;
        call_id: string;
        name: string;
        arguments: string;
    } | {
        type: "web_search_call";
        id: string;
        status: string;
    } | {
        type: "computer_call";
        id: string;
        status: string;
    } | {
        type: "file_search_call";
        id: string;
    } | {
        type: "image_generation_call";
        id: string;
    } | {
        type: "code_interpreter_call";
        id: string;
        container_id: string;
        code: string | null;
        outputs: ({
            type: "logs";
            logs: string;
        } | {
            type: "image";
            url: string;
        })[] | null;
        status: string;
    } | {
        type: "mcp_call";
        id: string;
        status: string;
        approval_request_id?: string | null | undefined;
    } | {
        type: "mcp_list_tools";
        id: string;
    } | {
        type: "mcp_approval_request";
        id: string;
    } | {
        type: "apply_patch_call";
        id: string;
        call_id: string;
        status: "completed" | "in_progress";
        operation: {
            type: "create_file";
            path: string;
            diff: string;
        } | {
            type: "delete_file";
            path: string;
        } | {
            type: "update_file";
            path: string;
            diff: string;
        };
    } | {
        type: "shell_call";
        id: string;
        call_id: string;
        status: "completed" | "in_progress" | "incomplete";
        action: {
            commands: string[];
        };
    };
} | {
    type: "response.output_item.done";
    output_index: number;
    item: {
        type: "message";
        id: string;
    } | {
        type: "reasoning";
        id: string;
        encrypted_content?: string | null | undefined;
    } | {
        type: "function_call";
        id: string;
        call_id: string;
        name: string;
        arguments: string;
        status: "completed";
    } | {
        type: "code_interpreter_call";
        id: string;
        code: string | null;
        container_id: string;
        outputs: ({
            type: "logs";
            logs: string;
        } | {
            type: "image";
            url: string;
        })[] | null;
    } | {
        type: "image_generation_call";
        id: string;
        result: string;
    } | {
        type: "web_search_call";
        id: string;
        status: string;
        action: {
            type: "search";
            query?: string | null | undefined;
            sources?: ({
                type: "url";
                url: string;
            } | {
                type: "api";
                name: string;
            })[] | null | undefined;
        } | {
            type: "open_page";
            url?: string | null | undefined;
        } | {
            type: "find_in_page";
            url?: string | null | undefined;
            pattern?: string | null | undefined;
        };
    } | {
        type: "file_search_call";
        id: string;
        queries: string[];
        results?: {
            attributes: Record<string, string | number | boolean>;
            file_id: string;
            filename: string;
            score: number;
            text: string;
        }[] | null | undefined;
    } | {
        type: "local_shell_call";
        id: string;
        call_id: string;
        action: {
            type: "exec";
            command: string[];
            timeout_ms?: number | undefined;
            user?: string | undefined;
            working_directory?: string | undefined;
            env?: Record<string, string> | undefined;
        };
    } | {
        type: "computer_call";
        id: string;
        status: "completed";
    } | {
        type: "mcp_call";
        id: string;
        status: string;
        arguments: string;
        name: string;
        server_label: string;
        output?: string | null | undefined;
        error?: string | {
            [x: string]: unknown;
            type?: string | undefined;
            code?: string | number | undefined;
            message?: string | undefined;
        } | null | undefined;
        approval_request_id?: string | null | undefined;
    } | {
        type: "mcp_list_tools";
        id: string;
        server_label: string;
        tools: {
            name: string;
            input_schema: any;
            description?: string | undefined;
            annotations?: Record<string, unknown> | undefined;
        }[];
        error?: string | {
            [x: string]: unknown;
            type?: string | undefined;
            code?: string | number | undefined;
            message?: string | undefined;
        } | undefined;
    } | {
        type: "mcp_approval_request";
        id: string;
        server_label: string;
        name: string;
        arguments: string;
        approval_request_id?: string | undefined;
    } | {
        type: "apply_patch_call";
        id: string;
        call_id: string;
        status: "completed" | "in_progress";
        operation: {
            type: "create_file";
            path: string;
            diff: string;
        } | {
            type: "delete_file";
            path: string;
        } | {
            type: "update_file";
            path: string;
            diff: string;
        };
    } | {
        type: "shell_call";
        id: string;
        call_id: string;
        status: "completed" | "in_progress" | "incomplete";
        action: {
            commands: string[];
        };
    };
} | {
    type: "response.function_call_arguments.delta";
    item_id: string;
    output_index: number;
    delta: string;
} | {
    type: "response.image_generation_call.partial_image";
    item_id: string;
    output_index: number;
    partial_image_b64: string;
} | {
    type: "response.code_interpreter_call_code.delta";
    item_id: string;
    output_index: number;
    delta: string;
} | {
    type: "response.code_interpreter_call_code.done";
    item_id: string;
    output_index: number;
    code: string;
} | {
    type: "response.output_text.annotation.added";
    annotation: {
        type: "url_citation";
        start_index: number;
        end_index: number;
        url: string;
        title: string;
    } | {
        type: "file_citation";
        file_id: string;
        filename: string;
        index: number;
    } | {
        type: "container_file_citation";
        container_id: string;
        file_id: string;
        filename: string;
        start_index: number;
        end_index: number;
    } | {
        type: "file_path";
        file_id: string;
        index: number;
    };
} | {
    type: "response.reasoning_summary_part.added";
    item_id: string;
    summary_index: number;
} | {
    type: "response.reasoning_summary_text.delta";
    item_id: string;
    summary_index: number;
    delta: string;
} | {
    type: "response.reasoning_summary_part.done";
    item_id: string;
    summary_index: number;
} | {
    type: "response.apply_patch_call_operation_diff.delta";
    item_id: string;
    output_index: number;
    delta: string;
    obfuscation?: string | null | undefined;
} | {
    type: "response.apply_patch_call_operation_diff.done";
    item_id: string;
    output_index: number;
    diff: string;
} | {
    type: "error";
    sequence_number: number;
    error: {
        type: string;
        code: string;
        message: string;
        param?: string | null | undefined;
    };
}>;

/**
 * Type definitions for the apply_patch operations.
 */
type ApplyPatchOperation = {
    type: 'create_file';
    /**
     * Path of the file to create relative to the workspace root.
     */
    path: string;
    /**
     * Unified diff content to apply when creating the file.
     */
    diff: string;
} | {
    type: 'delete_file';
    /**
     * Path of the file to delete relative to the workspace root.
     */
    path: string;
} | {
    type: 'update_file';
    /**
     * Path of the file to update relative to the workspace root.
     */
    path: string;
    /**
     * Unified diff content to apply to the existing file.
     */
    diff: string;
};

declare const openaiTools: {
    /**
     * The apply_patch tool lets GPT-5.1 create, update, and delete files in your
     * codebase using structured diffs. Instead of just suggesting edits, the model
     * emits patch operations that your application applies and then reports back on,
     * enabling iterative, multi-step code editing workflows.
     *
     */
    applyPatch: _ai_sdk_provider_utils.ProviderToolFactoryWithOutputSchema<{
        callId: string;
        operation: ApplyPatchOperation;
    }, {
        status: "completed" | "failed";
        output?: string;
    }, {}>;
    /**
     * The Code Interpreter tool allows models to write and run Python code in a
     * sandboxed environment to solve complex problems in domains like data analysis,
     * coding, and math.
     *
     * @param container - The container to use for the code interpreter.
     */
    codeInterpreter: (args?: {
        container?: string | {
            fileIds?: string[];
        };
    }) => _ai_sdk_provider_utils.Tool<{
        code?: string | null;
        containerId: string;
    }, {
        outputs?: Array<{
            type: "logs";
            logs: string;
        } | {
            type: "image";
            url: string;
        }> | null;
    }>;
    /**
     * File search is a tool available in the Responses API. It enables models to
     * retrieve information in a knowledge base of previously uploaded files through
     * semantic and keyword search.
     *
     * @param vectorStoreIds - The vector store IDs to use for the file search.
     * @param maxNumResults - The maximum number of results to return.
     * @param ranking - The ranking options to use for the file search.
     * @param filters - The filters to use for the file search.
     */
    fileSearch: _ai_sdk_provider_utils.ProviderToolFactoryWithOutputSchema<{}, {
        queries: string[];
        results: null | {
            attributes: Record<string, unknown>;
            fileId: string;
            filename: string;
            score: number;
            text: string;
        }[];
    }, {
        vectorStoreIds: string[];
        maxNumResults?: number;
        ranking?: {
            ranker?: string;
            scoreThreshold?: number;
        };
        filters?: OpenAIResponsesFileSearchToolComparisonFilter | OpenAIResponsesFileSearchToolCompoundFilter;
    }>;
    /**
     * The image generation tool allows you to generate images using a text prompt,
     * and optionally image inputs. It leverages the GPT Image model,
     * and automatically optimizes text inputs for improved performance.
     *
     * @param background - Background type for the generated image. One of 'auto', 'opaque', or 'transparent'.
     * @param inputFidelity - Input fidelity for the generated image. One of 'low' or 'high'.
     * @param inputImageMask - Optional mask for inpainting. Contains fileId and/or imageUrl.
     * @param model - The image generation model to use. Default: gpt-image-1.
     * @param moderation - Moderation level for the generated image. Default: 'auto'.
     * @param outputCompression - Compression level for the output image (0-100).
     * @param outputFormat - The output format of the generated image. One of 'png', 'jpeg', or 'webp'.
     * @param partialImages - Number of partial images to generate in streaming mode (0-3).
     * @param quality - The quality of the generated image. One of 'auto', 'low', 'medium', or 'high'.
     * @param size - The size of the generated image. One of 'auto', '1024x1024', '1024x1536', or '1536x1024'.
     */
    imageGeneration: (args?: {
        background?: "auto" | "opaque" | "transparent";
        inputFidelity?: "low" | "high";
        inputImageMask?: {
            fileId?: string;
            imageUrl?: string;
        };
        model?: string;
        moderation?: "auto";
        outputCompression?: number;
        outputFormat?: "png" | "jpeg" | "webp";
        partialImages?: number;
        quality?: "auto" | "low" | "medium" | "high";
        size?: "auto" | "1024x1024" | "1024x1536" | "1536x1024";
    }) => _ai_sdk_provider_utils.Tool<{}, {
        result: string;
    }>;
    /**
     * Local shell is a tool that allows agents to run shell commands locally
     * on a machine you or the user provides.
     *
     * Supported models: `gpt-5-codex` and `codex-mini-latest`
     */
    localShell: _ai_sdk_provider_utils.ProviderToolFactoryWithOutputSchema<{
        action: {
            type: "exec";
            command: string[];
            timeoutMs?: number;
            user?: string;
            workingDirectory?: string;
            env?: Record<string, string>;
        };
    }, {
        output: string;
    }, {}>;
    /**
     * The shell tool allows the model to interact with your local computer through
     * a controlled command-line interface. The model proposes shell commands; your
     * integration executes them and returns the outputs.
     *
     * Available through the Responses API for use with GPT-5.1.
     *
     * WARNING: Running arbitrary shell commands can be dangerous. Always sandbox
     * execution or add strict allow-/deny-lists before forwarding a command to
     * the system shell.
     */
    shell: _ai_sdk_provider_utils.ProviderToolFactoryWithOutputSchema<{
        action: {
            commands: string[];
            timeoutMs?: number;
            maxOutputLength?: number;
        };
    }, {
        output: Array<{
            stdout: string;
            stderr: string;
            outcome: {
                type: "timeout";
            } | {
                type: "exit";
                exitCode: number;
            };
        }>;
    }, {}>;
    /**
     * Web search allows models to access up-to-date information from the internet
     * and provide answers with sourced citations.
     *
     * @param searchContextSize - The search context size to use for the web search.
     * @param userLocation - The user location to use for the web search.
     */
    webSearchPreview: _ai_sdk_provider_utils.ProviderToolFactoryWithOutputSchema<{}, {
        action: {
            type: "search";
            query?: string;
        } | {
            type: "openPage";
            url?: string | null;
        } | {
            type: "findInPage";
            url?: string | null;
            pattern?: string | null;
        };
    }, {
        searchContextSize?: "low" | "medium" | "high";
        userLocation?: {
            type: "approximate";
            country?: string;
            city?: string;
            region?: string;
            timezone?: string;
        };
    }>;
    /**
     * Web search allows models to access up-to-date information from the internet
     * and provide answers with sourced citations.
     *
     * @param filters - The filters to use for the web search.
     * @param searchContextSize - The search context size to use for the web search.
     * @param userLocation - The user location to use for the web search.
     */
    webSearch: (args?: Parameters<typeof webSearchToolFactory>[0]) => _ai_sdk_provider_utils.Tool<{}, {
        action: {
            type: "search";
            query?: string;
        } | {
            type: "openPage";
            url?: string | null;
        } | {
            type: "findInPage";
            url?: string | null;
            pattern?: string | null;
        };
        sources?: Array<{
            type: "url";
            url: string;
        } | {
            type: "api";
            name: string;
        }>;
    }>;
    /**
     * MCP (Model Context Protocol) allows models to call tools exposed by
     * remote MCP servers or service connectors.
     *
     * @param serverLabel - Label to identify the MCP server.
     * @param allowedTools - Allowed tool names or filter object.
     * @param authorization - OAuth access token for the MCP server/connector.
     * @param connectorId - Identifier for a service connector.
     * @param headers - Optional headers to include in MCP requests.
     * // param requireApproval - Approval policy ('always'|'never'|filter object). (Removed - always 'never')
     * @param serverDescription - Optional description of the server.
     * @param serverUrl - URL for the MCP server.
     */
    mcp: (args: {
        serverLabel: string;
        allowedTools?: string[] | {
            readOnly?: boolean;
            toolNames?: string[];
        };
        authorization?: string;
        connectorId?: string;
        headers?: Record<string, string>;
        requireApproval?: "always" | "never" | {
            never?: {
                toolNames?: string[];
            };
        };
        serverDescription?: string;
        serverUrl?: string;
    }) => _ai_sdk_provider_utils.Tool<{}, {
        type: "call";
        serverLabel: string;
        name: string;
        arguments: string;
        output?: string | null;
        error?: _ai_sdk_provider.JSONValue;
    }>;
};

type OpenAIResponsesModelId = 'chatgpt-4o-latest' | 'gpt-3.5-turbo-0125' | 'gpt-3.5-turbo-1106' | 'gpt-3.5-turbo' | 'gpt-4-0613' | 'gpt-4-turbo-2024-04-09' | 'gpt-4-turbo' | 'gpt-4.1-2025-04-14' | 'gpt-4.1-mini-2025-04-14' | 'gpt-4.1-mini' | 'gpt-4.1-nano-2025-04-14' | 'gpt-4.1-nano' | 'gpt-4.1' | 'gpt-4' | 'gpt-4o-2024-05-13' | 'gpt-4o-2024-08-06' | 'gpt-4o-2024-11-20' | 'gpt-4o-mini-2024-07-18' | 'gpt-4o-mini' | 'gpt-4o' | 'gpt-5.1' | 'gpt-5.1-chat-latest' | 'gpt-5.1-codex-mini' | 'gpt-5.1-codex' | 'gpt-5.1-codex-max' | 'gpt-5.2' | 'gpt-5.2-chat-latest' | 'gpt-5.2-pro' | 'gpt-5-2025-08-07' | 'gpt-5-chat-latest' | 'gpt-5-codex' | 'gpt-5-mini-2025-08-07' | 'gpt-5-mini' | 'gpt-5-nano-2025-08-07' | 'gpt-5-nano' | 'gpt-5-pro-2025-10-06' | 'gpt-5-pro' | 'gpt-5' | 'o1-2024-12-17' | 'o1' | 'o3-2025-04-16' | 'o3-mini-2025-01-31' | 'o3-mini' | 'o3' | (string & {});
declare const openaiResponsesProviderOptionsSchema: _ai_sdk_provider_utils.LazySchema<{
    conversation?: string | null | undefined;
    include?: ("file_search_call.results" | "message.output_text.logprobs" | "reasoning.encrypted_content")[] | null | undefined;
    instructions?: string | null | undefined;
    logprobs?: number | boolean | undefined;
    maxToolCalls?: number | null | undefined;
    metadata?: any;
    parallelToolCalls?: boolean | null | undefined;
    previousResponseId?: string | null | undefined;
    promptCacheKey?: string | null | undefined;
    promptCacheRetention?: "in_memory" | "24h" | null | undefined;
    reasoningEffort?: string | null | undefined;
    reasoningSummary?: string | null | undefined;
    safetyIdentifier?: string | null | undefined;
    serviceTier?: "default" | "auto" | "flex" | "priority" | null | undefined;
    store?: boolean | null | undefined;
    strictJsonSchema?: boolean | null | undefined;
    textVerbosity?: "low" | "medium" | "high" | null | undefined;
    truncation?: "auto" | "disabled" | null | undefined;
    user?: string | null | undefined;
    systemMessageMode?: "remove" | "system" | "developer" | undefined;
    forceReasoning?: boolean | undefined;
}>;
type OpenAIResponsesProviderOptions = InferSchema<typeof openaiResponsesProviderOptionsSchema>;

type OpenAISpeechModelId = 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts' | (string & {});

type OpenAITranscriptionModelId = 'whisper-1' | 'gpt-4o-mini-transcribe' | 'gpt-4o-transcribe' | (string & {});

interface OpenAIProvider extends ProviderV3 {
    (modelId: OpenAIResponsesModelId): LanguageModelV3;
    /**
  Creates an OpenAI model for text generation.
     */
    languageModel(modelId: OpenAIResponsesModelId): LanguageModelV3;
    /**
  Creates an OpenAI chat model for text generation.
     */
    chat(modelId: OpenAIChatModelId): LanguageModelV3;
    /**
  Creates an OpenAI responses API model for text generation.
     */
    responses(modelId: OpenAIResponsesModelId): LanguageModelV3;
    /**
  Creates an OpenAI completion model for text generation.
     */
    completion(modelId: OpenAICompletionModelId): LanguageModelV3;
    /**
  Creates a model for text embeddings.
     */
    embedding(modelId: OpenAIEmbeddingModelId): EmbeddingModelV3;
    /**
  Creates a model for text embeddings.
     */
    embeddingModel(modelId: OpenAIEmbeddingModelId): EmbeddingModelV3;
    /**
     * @deprecated Use `embedding` instead.
     */
    textEmbedding(modelId: OpenAIEmbeddingModelId): EmbeddingModelV3;
    /**
     * @deprecated Use `embeddingModel` instead.
     */
    textEmbeddingModel(modelId: OpenAIEmbeddingModelId): EmbeddingModelV3;
    /**
  Creates a model for image generation.
     */
    image(modelId: OpenAIImageModelId): ImageModelV3;
    /**
  Creates a model for image generation.
     */
    imageModel(modelId: OpenAIImageModelId): ImageModelV3;
    /**
  Creates a model for transcription.
     */
    transcription(modelId: OpenAITranscriptionModelId): TranscriptionModelV3;
    /**
  Creates a model for speech generation.
     */
    speech(modelId: OpenAISpeechModelId): SpeechModelV3;
    /**
  OpenAI-specific tools.
     */
    tools: typeof openaiTools;
}
interface OpenAIProviderSettings {
    /**
  Base URL for the OpenAI API calls.
       */
    baseURL?: string;
    /**
  API key for authenticating requests.
       */
    apiKey?: string;
    /**
  OpenAI Organization.
       */
    organization?: string;
    /**
  OpenAI project.
       */
    project?: string;
    /**
  Custom headers to include in the requests.
       */
    headers?: Record<string, string>;
    /**
  Provider name. Overrides the `openai` default name for 3rd party providers.
     */
    name?: string;
    /**
  Custom fetch implementation. You can use it as a middleware to intercept requests,
  or to provide a custom fetch implementation for e.g. testing.
      */
    fetch?: FetchFunction;
}
/**
Create an OpenAI provider instance.
 */
declare function createOpenAI(options?: OpenAIProviderSettings): OpenAIProvider;
/**
Default OpenAI provider instance.
 */
declare const openai: OpenAIProvider;

type OpenaiResponsesChunk = InferSchema<typeof openaiResponsesChunkSchema>;
type ResponsesOutputTextAnnotationProviderMetadata = Extract<OpenaiResponsesChunk, {
    type: 'response.output_text.annotation.added';
}>['annotation'];
type ResponsesTextProviderMetadata = {
    itemId: string;
    annotations?: Array<ResponsesOutputTextAnnotationProviderMetadata>;
};
type OpenaiResponsesTextProviderMetadata = {
    openai: ResponsesTextProviderMetadata;
};
type ResponsesSourceDocumentProviderMetadata = {
    type: 'file_citation';
    fileId: string;
    index: number;
} | {
    type: 'container_file_citation';
    fileId: string;
    containerId: string;
} | {
    type: 'file_path';
    fileId: string;
    index: number;
};
type OpenaiResponsesSourceDocumentProviderMetadata = {
    openai: ResponsesSourceDocumentProviderMetadata;
};

declare const VERSION: string;

export { type OpenAIChatLanguageModelOptions, type OpenAIProvider, type OpenAIProviderSettings, type OpenAIResponsesProviderOptions, type OpenaiResponsesSourceDocumentProviderMetadata, type OpenaiResponsesTextProviderMetadata, VERSION, createOpenAI, openai };
