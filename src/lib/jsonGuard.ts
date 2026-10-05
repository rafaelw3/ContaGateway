/**
 * Valida profundidade e quantidade de campos de uma estrutura JSON de forma
 * iterativa (sem recursão), evitando custo de CPU desproporcional ao
 * processar `metadata` arbitrário enviado pelo cliente.
 */
export function assertBoundedJson(
  value: unknown,
  { maxDepth, maxEntries }: { maxDepth: number; maxEntries: number }
): void {
  let totalEntries = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;

    if (depth > maxDepth) {
      throw new Error(`metadata excede a profundidade máxima permitida (${maxDepth}).`);
    }

    if (node !== null && typeof node === 'object') {
      const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);

      totalEntries += children.length;
      if (totalEntries > maxEntries) {
        throw new Error(`metadata excede o número máximo de campos permitidos (${maxEntries}).`);
      }

      for (const child of children) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
}
