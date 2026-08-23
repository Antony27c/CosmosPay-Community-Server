import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Validates that a value is an absolute https URL without embedded credentials.
 * Domain allow-listing is enforced separately (per consumer) in the KYC services.
 */
export function IsRedirectUrl(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isRedirectUrl',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          let parsed: URL;
          try {
            parsed = new URL(value);
          } catch {
            return false;
          }
          return (
            parsed.protocol === 'https:' &&
            !parsed.username &&
            !parsed.password &&
            Boolean(parsed.hostname)
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid https URL without embedded credentials`;
        },
      },
    });
  };
}
