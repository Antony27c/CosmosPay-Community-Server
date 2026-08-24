import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Marks a property as required when `chainProperty` is one of `chains`.
 * Used for offramp `signed_transaction` on stellar/solana (from authorize).
 */
export function IsRequiredForChain(
  chainProperty: string,
  chains: readonly string[],
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isRequiredForChain',
      target: object.constructor,
      propertyName,
      constraints: [chainProperty, chains],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const [chainProp, requiredChains] = args.constraints as [
            string,
            readonly string[],
          ];
          const chain = (args.object as Record<string, unknown>)[chainProp];
          if (!requiredChains.includes(chain as string)) {
            // Optional for other chains: allow absent, or a non-empty string.
            return (
              value === undefined ||
              value === null ||
              (typeof value === 'string' && value.length > 0)
            );
          }
          return typeof value === 'string' && value.length > 0;
        },
        defaultMessage(args: ValidationArguments) {
          const [, requiredChains] = args.constraints as [
            string,
            readonly string[],
          ];
          return (
            `${args.property} is required when chain is ${requiredChains.join(' or ')}; ` +
            `obtain it from POST /v1/offramp/payouts/authorize`
          );
        },
      },
    });
  };
}
