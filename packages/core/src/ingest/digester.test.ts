import {
    DIGEST_MODELS,
    DEFAULT_DIGEST_MODEL,
    SessionDigester,
    estimateCost,
    memoryIdForSession,
    parseDigestResponse,
    renderDigestMemory,
    buildDigestPrompt,
} from './digester';
import { SessionDigest, SessionMeta } from './types';

jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: { generateContent: jest.fn() },
    })),
    Type: {
        OBJECT: 'OBJECT', STRING: 'STRING', ARRAY: 'ARRAY',
    },
}));

const META: SessionMeta = {
    sessionId: 'abc',
    source: 'factory',
    filePath: '/Users/me/.factory/sessions/proj/abc.jsonl',
    cwd: '/Users/me/project',
    gitBranch: 'main',
    firstTs: Date.parse('2026-03-24T04:04:42.386Z'),
    lastTs: Date.parse('2026-03-24T05:00:00.000Z'),
};

const DIGEST: SessionDigest = {
    title: 'Set up SSE chat streaming',
    whatWasDone: 'Implemented streaming.',
    howToReproduce: ['Run pnpm dev', 'Open /chat'],
    toolsAndServices: ['xcrun notarytool — Apple notarization'],
    credentialsAndConfig: ['Keychain profile `gemdex-notary`'],
    gotchas: ['CORS needs the streaming header'],
};

describe('parseDigestResponse', () => {
    it('parses a full structured response', () => {
        const digest = parseDigestResponse(JSON.stringify({
            title: 'T',
            what_was_done: 'W',
            how_to_reproduce: ['a'],
            tools_and_services: ['b'],
            credentials_and_config: ['c'],
            gotchas: ['d'],
        }));
        expect(digest).toEqual({
            title: 'T',
            whatWasDone: 'W',
            howToReproduce: ['a'],
            toolsAndServices: ['b'],
            credentialsAndConfig: ['c'],
            gotchas: ['d'],
        });
    });

    it('defaults missing arrays to empty', () => {
        const digest = parseDigestResponse(JSON.stringify({ title: 'T', what_was_done: 'W' }));
        expect(digest.howToReproduce).toEqual([]);
        expect(digest.gotchas).toEqual([]);
    });

    it('throws on invalid JSON and missing required fields', () => {
        expect(() => parseDigestResponse('not json')).toThrow(/invalid JSON/);
        expect(() => parseDigestResponse(JSON.stringify({ title: 'T' }))).toThrow(/what_was_done/);
    });
});

describe('renderDigestMemory', () => {
    it('renders header, sections, and the provenance footer', () => {
        const content = renderDigestMemory(DIGEST, META);
        expect(content).toContain('Source: Factory CLI · Repo: /Users/me/project (main) · 2026-03-24');
        expect(content).toContain('## How to reproduce\n1. Run pnpm dev\n2. Open /chat');
        expect(content).toContain('## Tools & services\n- xcrun notarytool — Apple notarization');
        expect(content).toContain('## Credentials & config');
        expect(content).toContain('## Gotchas');
        expect(content).toContain(`Full transcript: ${META.filePath}`);
    });

    it('omits empty sections', () => {
        const content = renderDigestMemory({ ...DIGEST, gotchas: [], credentialsAndConfig: [] }, META);
        expect(content).not.toContain('## Gotchas');
        expect(content).not.toContain('## Credentials & config');
    });
});

describe('memoryIdForSession', () => {
    it('is deterministic across runs', () => {
        expect(memoryIdForSession(META)).toBe('chat:factory:abc');
        expect(memoryIdForSession({ source: 'claude', sessionId: 'x-1' })).toBe('chat:claude:x-1');
    });
});

describe('estimateCost', () => {
    it('computes standard and 50% batch pricing per model', () => {
        const estimates = estimateCost(1_000_000, 0);
        const flash = estimates.find((estimate) => estimate.model === 'gemini-3.5-flash-lite')!;
        expect(flash.standardUsd).toBeCloseTo(DIGEST_MODELS['gemini-3.5-flash-lite'].inputUsdPerMTok, 2);
        // batchUsd is rounded independently of standardUsd / 2
        expect(flash.batchUsd).toBeCloseTo(Number((flash.standardUsd / 2).toFixed(2)), 2);
        expect(estimates).toHaveLength(Object.keys(DIGEST_MODELS).length);
    });
});

describe('buildDigestPrompt', () => {
    it('includes context lines and the transcript', () => {
        const prompt = buildDigestPrompt({
            ...META,
            title: 'My session',
            turns: [{ role: 'user', text: 'do the thing' }],
        });
        expect(prompt).toContain('Agent: Factory CLI');
        expect(prompt).toContain('Working directory: /Users/me/project');
        expect(prompt).toContain('Git branch: main');
        expect(prompt).toContain('Session title: My session');
        expect(prompt).toContain('User:\ndo the thing');
    });
});

describe('SessionDigester', () => {
    it('defaults to gemini-3.5-flash-lite and rejects unknown models', () => {
        expect(new SessionDigester({ apiKey: 'k' }).model).toBe(DEFAULT_DIGEST_MODEL);
        expect(() => new SessionDigester({ apiKey: 'k', model: 'gemini-1.5-pro' }))
            .toThrow(/Unsupported digest model/);
    });

    it('digests via generateContent and parses the JSON text', async () => {
        const digester = new SessionDigester({ apiKey: 'k' });
        const generateContent = (digester.getClient().models.generateContent as jest.Mock);
        generateContent.mockResolvedValue({
            text: JSON.stringify({ title: 'T', what_was_done: 'W' }),
        });
        const digest = await digester.digest({ ...META, turns: [{ role: 'user', text: 'hi' }] });
        expect(digest.title).toBe('T');
        expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({
            model: DEFAULT_DIGEST_MODEL,
            config: expect.objectContaining({ responseMimeType: 'application/json' }),
        }));
    });

    it('throws when the model returns no text', async () => {
        const digester = new SessionDigester({ apiKey: 'k' });
        (digester.getClient().models.generateContent as jest.Mock).mockResolvedValue({ text: undefined });
        await expect(digester.digest({ ...META, turns: [] })).rejects.toThrow(/empty response/);
    });
});
